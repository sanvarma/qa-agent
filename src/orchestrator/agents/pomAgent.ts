import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LLMClient } from '../../llm/client.js';
import type { ToolContext } from '../../tools/tool.js';
import { ToolRegistry } from '../../tools/registry.js';
import { runAgent, type AgentResult } from '../../agent/loop.js';
import type { ConversationLog } from '../../agent/conversationLog.js';
import { pomCreatePageTool } from '../../tools/pom/createPage.js';
import { pomAddSelectorTool } from '../../tools/pom/addSelector.js';
import { pomUpdateSelectorTool } from '../../tools/pom/updateSelector.js';
import { pomEditMethodTool } from '../../tools/pom/editMethod.js';
import { fixtureAddPageTool } from '../../tools/fixture/addPage.js';
import { extractElementsTool } from '../../tools/browser/extractElements.js';
import { fsReadTool } from '../../tools/fs/read.js';
import type { TestCase } from '../testCase.js';
import { renderTestCase } from '../testCase.js';
import type { AgentLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Tool registry — POM tools + extraction tool only. No browse, no test tools.
// ---------------------------------------------------------------------------

function buildPomRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(extractElementsTool);
  reg.register(pomCreatePageTool);
  reg.register(pomAddSelectorTool);
  reg.register(pomUpdateSelectorTool);
  reg.register(pomEditMethodTool);
  reg.register(fixtureAddPageTool);
  return reg;
}

// ---------------------------------------------------------------------------
// Pre-compute existing pages from pages.fixture.ts — no LLM cost
// ---------------------------------------------------------------------------

export async function readExistingPages(repoRoot: string): Promise<string> {
  const fixturePath = join(repoRoot, 'src', 'fixtures', 'pages.fixture.ts');
  let content: string;
  try {
    content = await readFile(fixturePath, 'utf8');
  } catch {
    return 'none';
  }

  // className → fixtureName from the extend block
  // Match: fixtureName: async ... ?? ClassName (non-greedy across lines)
  const fixtureMap = new Map<string, string>();
  const fixtureRe = /(\w+):\s*async[\s\S]*?\?\?\s*(\w+)/g;
  let m: RegExpExecArray | null;
  while ((m = fixtureRe.exec(content)) !== null) {
    fixtureMap.set(m[2], m[1]); // className → fixtureName
  }

  // className → file path from imports
  const importRe = /import\s*\{[^}]*\b(\w+)\b[^}]*\}\s*from\s*['"]([^'"]*pages[^'"]*)['"]/g;
  const entries: string[] = [];
  while ((m = importRe.exec(content)) !== null) {
    const className = m[1];
    const fixtureName = fixtureMap.get(className);
    if (fixtureName) {
      // Derive file path from import specifier: convert relative to repo-relative
      const rel = m[2].replace(/^\.\.\//, 'src/').replace(/^\.\//, 'src/fixtures/') + '.ts';
      entries.push(`${className} (fixture: ${fixtureName}, file: ${rel})`);
    }
  }

  return entries.length > 0 ? entries.join('\n  ') : 'none';
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const POM_AGENT_SYSTEM = `You are a POM agent. Your only job: ensure every Page Object Model (POM) needed by the test exists on disk with the correct fields and methods.

## Browser tool
page.extractElements(url, { setupFlow? }) — extracts all interactive elements from a page.
  Public pages (no login required): call with URL only.
  Auth-gated pages: pass setupFlow — 'account' | 'cart' | 'checkout' | 'payment'
  Returns ExtractedElement[] with bestSelector for each element.
  Call all pages in ONE batched step. Never call it twice for the same page.

## Other tools
fs.read — read an existing POM file before editing its methods or checking its fields.
pom.createPage — create a new POM at src/pages/common/<ClassName>.ts (flat, NO subdirectories).
pom.addSelector — add a missing field to an existing POM.
pom.updateSelector — replace the selector string on an existing POM field.
pom.editMethod — add or replace a method on a POM.
fixture.addPage — register a POM in src/fixtures/pages.fixture.ts.

## Rules
EXISTING POMS: The task prompt lists all already-registered POMs with their fixture names and file paths.
  Do NOT call page.extractElements for already-registered pages.
  Use fs.read on the file if you need to inspect its fields before adding missing ones.
EXTRACT ONCE: Call page.extractElements for missing pages only — all in ONE batched step.
  Go straight from extracted elements → pom.createPage. Do NOT re-extract.
SELECTORS: Use bestSelector from extracted elements as field selectors.
CREATE: pom.createPage file MUST be src/pages/common/<ClassName>.ts — never in subdirectories.
METHODS: Any test step requiring 2+ sequential interactions on one page MUST become a POM method.
  Method body uses this.fieldName references. Never inline fill/click sequences.
  COMPLETE ACTION methods (verb implies full action: login, submit, confirm, add): include ALL clicks.
  FORM-FILL methods (named fillX, enterX, typeX): fill fields ONLY — no submit/continue click.
    The submit click stays as an explicit field reference so the test controls page transitions.
  ✅ login(): fills credentials + clicks login button — complete action, includes the click.
  ✅ fillShippingInfo(): fills form fields only — stops before the continue/submit click.
  ❌ fillShippingInfo(): fills fields AND clicks submit — test then double-clicks.
ATOMIC PAIR: Every pom.createPage MUST have a fixture.addPage in the same batch — no exceptions.
SCOPE: Do NOT create spec files. Do NOT call test.* tools. Stop when all POMs are ready.
BATCH — this is strict:
  ALL pom.createPage + fixture.addPage calls MUST be in ONE single response — never spread across multiple turns.
  ALL pom.editMethod calls MUST be in ONE single response — never spread across multiple turns.
  ❌ WRONG: one createPage per response, stepping through pages one by one.
  ✅ CORRECT: one response containing createPage+addPage for every missing page at once.`;

// ---------------------------------------------------------------------------
// Task prompt
// ---------------------------------------------------------------------------

function buildPomTask(tc: TestCase, baseUrl: string, existingPages: string): string {
  return [
    'Prepare all Page Object Models needed for this test case.',
    '',
    renderTestCase(tc),
    '',
    `Base URL: ${baseUrl}`,
    '',
    `Already registered POMs (do NOT re-extract these):`,
    `  ${existingPages}`,
    '',
    'Steps:',
    '  1. Identify all pages needed by the test steps.',
    '  2. For pages NOT already registered above, call page.extractElements in ONE batched step.',
    '       page.extractElements(url) for public pages.',
    '       page.extractElements(url, { setupFlow }) for auth-gated pages:',
    '         setupFlow: "account" | "cart" | "checkout" | "payment"',
    '  3. In ONE single response, call pom.createPage + fixture.addPage for ALL missing pages at once.',
    '       Every page gets its own pom.createPage AND fixture.addPage — all in the same response.',
    '       Do NOT create pages one per response. One response = all pages.',
    '  4. In ONE single response, call pom.editMethod for ALL methods across ALL pages.',
    '       Do NOT add methods one per response. One response = all methods.',
    '  5. For existing POMs missing fields, use fs.read to inspect the file then pom.addSelector.',
    '  6. Stop — do NOT write tests.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PomAgentDeps {
  llm: LLMClient;
  toolCtx: ToolContext;
  conversationLog: ConversationLog;
  agentLogger: AgentLogger;
  model: string;
  maxTokens: number;
}

export async function runPomAgent(
  tc: TestCase,
  baseUrl: string,
  deps: PomAgentDeps,
): Promise<AgentResult> {
  const { llm, toolCtx, conversationLog, agentLogger, model, maxTokens } = deps;

  await agentLogger.info('pom', 'phase.enter', 0);

  try {
    const existingPages = await readExistingPages(toolCtx.repoRoot);
    const result = await runAgent(
      buildPomTask(tc, baseUrl, existingPages),
      { maxSteps: 20, model, maxTokens, system: POM_AGENT_SYSTEM },
      { llm, tools: buildPomRegistry(), toolCtx, state: conversationLog },
    );
    await agentLogger.info('pom', 'phase.ok', 0, { steps: result.steps, usage: result.usage });
    return result;
  } catch (err) {
    await agentLogger.error('pom', 'phase.error', 0, { message: (err as Error).message });
    throw err;
  }
}
