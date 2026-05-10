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
import { frameworkGetGraphTool } from '../../tools/framework/getGraph.js';
import type { TestCase } from '../testCase.js';
import { renderTestCase } from '../testCase.js';
import type { AgentLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Tool registry — POM tools + extraction tool only. No browse, no test tools.
// ---------------------------------------------------------------------------

function buildPomRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(frameworkGetGraphTool);
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
fs.read — read an existing POM file when you need a method's BODY or a field's SELECTOR VALUE.
  The graph already lists every field name and method signature — do NOT fs.read just to check
  what fields or methods exist. Use the graph for existence checks; use fs.read for content.
pom.createPage — create a new POM at src/pages/common/<ClassName>.ts (flat, NO subdirectories).
pom.addSelector — add a missing field to an existing POM.
pom.updateSelector — replace the selector string on an existing POM field.
pom.editMethod — add or replace a method on a POM.
fixture.addPage — register a POM in src/fixtures/pages.fixture.ts.

## Rules
GRAPH FIRST: Call framework.getGraph at step 1. It shows every POM currently on disk. Use it to identify what is missing before doing anything else.
EXISTING POMS: The task prompt lists all already-registered POMs with their fixture names and file paths.
  Do NOT call page.extractElements for already-registered pages.
  The graph already shows their field names and method signatures — compare against the test steps
  to find what's missing, then call pom.addSelector / pom.editMethod directly.
  Only fs.read when you need a method's body (before replacing it) or a field's selector value.
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
NO POST-EDIT VERIFICATION: pom.createPage, pom.addSelector, pom.updateSelector, pom.editMethod,
  and fixture.addPage either succeed or throw. After a successful edit, do NOT fs.read the file
  or call framework.getGraph again to confirm. The test runs in the next phase — that is the
  verification. Stop as soon as the last edit succeeds.
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
    '  1. Call framework.getGraph — see every POM, field, and method currently on disk.',
    '  2. Compare the graph against the test steps. Identify every page needed that is NOT in the graph.',
    '  3. For pages NOT in the graph, call page.extractElements in ONE batched step.',
    '       page.extractElements(url) for public pages.',
    '       page.extractElements(url, { setupFlow }) for auth-gated pages:',
    '         setupFlow: "account" | "cart" | "checkout" | "payment"',
    '  4. In ONE single response, call pom.createPage + fixture.addPage for ALL missing pages at once.',
    '       Every page gets its own pom.createPage AND fixture.addPage — all in the same response.',
    '       Do NOT create pages one per response. One response = all pages.',
    '  5. In ONE single response, call pom.editMethod for ALL methods across ALL pages.',
    '       Do NOT add methods one per response. One response = all methods.',
    '  6. For existing POMs missing fields (compare graph vs test steps), call pom.addSelector directly.',
    '       fs.read is only needed if you must see a method body before pom.editMethod replaces it,',
    '       or a field selector value to mirror in a similar new field.',
    '  7. Stop after the last successful edit — do NOT re-read files or call getGraph to verify.',
    '       Do NOT write tests — that is a separate phase.',
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
