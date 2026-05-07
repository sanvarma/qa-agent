import type { LLMClient } from '../../llm/client.js';
import type { ToolContext } from '../../tools/tool.js';
import { ToolRegistry } from '../../tools/registry.js';
import { runAgent, type AgentResult } from '../../agent/loop.js';
import type { ConversationLog } from '../../agent/conversationLog.js';
import { frameworkGetGraphTool } from '../../tools/framework/getGraph.js';
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
// System prompt — POM rules only, target ≤ 300 tokens
// ---------------------------------------------------------------------------

const POM_AGENT_SYSTEM = `You are a POM agent. Your only job: ensure every Page Object Model (POM) needed by the test exists on disk with the correct fields and methods.

## Browser tool
page.extractElements(url, { setupFlow? }) — extracts all interactive elements from a page.
  Public pages (login, products, product-detail): call with URL only.
  Auth-gated pages: pass setupFlow — 'account' | 'cart' | 'checkout' | 'payment'
  Returns ExtractedElement[] with bestSelector for each element.
  Call all pages in ONE batched step. Never call it twice for the same page.

## Other tools
framework.getGraph — full POM inventory (fields, method signatures, fixture status). Call ONCE first.
fs.read — read an existing POM file before editing its methods.
pom.createPage — create a new POM at src/pages/common/<ClassName>.ts (flat, NO subdirectories).
pom.addSelector — add a missing field to an existing POM.
pom.updateSelector — replace the selector string on an existing POM field.
pom.editMethod — add or replace a method on a POM.
fixture.addPage — register a POM in src/fixtures/pages.fixture.ts.

## Rules
GRAPH FIRST: Call framework.getGraph at step 1. Use field and method names exactly as they appear.
EXTRACT ONCE: Call page.extractElements for all pages in one batched step immediately after getGraph.
  Do NOT re-extract or open sessions for pages already extracted. Use those results to create POMs.
SELECTORS: Use bestSelector from extracted elements as field selectors.
CREATE: pom.createPage file MUST be src/pages/common/<ClassName>.ts — never in subdirectories.
  After extracting, go straight to pom.createPage — do not navigate further to verify selectors.
METHODS: Any test step requiring 2+ sequential interactions on one page MUST become a POM method.
  Method body uses this.fieldName references. Never inline fill/click sequences.
ATOMIC PAIR: Every pom.createPage MUST have a fixture.addPage in the same batch — no exceptions.
CLOSE: Always call page.close(sessionId) when done with a session.
SCOPE: Do NOT create spec files. Do NOT call test.* tools. Stop when all POMs are ready.
BATCH: Combine independent tool calls in one response. Create all POMs in as few steps as possible.`;

// ---------------------------------------------------------------------------
// Task prompt
// ---------------------------------------------------------------------------

function buildPomTask(tc: TestCase, baseUrl: string): string {
  return [
    'Prepare all Page Object Models needed for this test case.',
    '',
    renderTestCase(tc),
    '',
    `Base URL: ${baseUrl}`,
    '',
    'Steps:',
    '  1. Call framework.getGraph — your source of truth for existing POMs, fields, and methods.',
    '  2. Identify all pages needed. In ONE batched call, extract elements for every missing page:',
    '       page.extractElements(url) for public pages (login, products, product-detail).',
    '       page.extractElements(url, { setupFlow }) for auth-gated pages:',
    '         setupFlow: "account" | "cart" | "checkout" | "payment"',
    '     Do this in a single step — all pages at once.',
    '  3. Using ONLY the extracted elements from step 2, create all missing POMs in one batched call:',
    '       pom.createPage + fixture.addPage for each page (always paired, always in the same batch).',
    '     Do NOT open sessions. Do NOT re-extract. Go straight from elements → pom.createPage.',
    '  4. Add methods for steps requiring 2+ sequential interactions on one page:',
    '       pom.editMethod(file, name, params, newBody)',
    '       e.g. login(username, password): this.emailInput.fill(username); this.passwordInput.fill(password); this.loginButton.click()',
    '  5. For existing POMs missing fields, call pom.addSelector.',
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
    const result = await runAgent(
      buildPomTask(tc, baseUrl),
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
