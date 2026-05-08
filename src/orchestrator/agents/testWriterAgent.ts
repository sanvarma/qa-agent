import type { LLMClient } from '../../llm/client.js';
import type { ToolContext } from '../../tools/tool.js';
import { ToolRegistry } from '../../tools/registry.js';
import { runAgent, type AgentResult } from '../../agent/loop.js';
import type { ConversationLog } from '../../agent/conversationLog.js';
import { frameworkGetGraphTool } from '../../tools/framework/getGraph.js';
import { testDataGetSchemaTool } from '../../tools/testdata/getSchema.js';
import { testCreateSpecTool } from '../../tools/test/createSpec.js';
import { testAddCaseTool } from '../../tools/test/addCase.js';
import { astAddImportTool } from '../../tools/ast/addImport.js';
import { fsReadTool } from '../../tools/fs/read.js';
import type { TestCase } from '../testCase.js';
import { renderTestCase } from '../testCase.js';
import type { AgentLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Tool registry — test tools only. No browse, no POM creation tools.
// ---------------------------------------------------------------------------

function buildTestWriterRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(frameworkGetGraphTool);
  reg.register(testDataGetSchemaTool);
  reg.register(testCreateSpecTool);
  reg.register(testAddCaseTool);
  reg.register(astAddImportTool);
  return reg;
}

// ---------------------------------------------------------------------------
// System prompt — test writing rules only, target ≤ 300 tokens
// ---------------------------------------------------------------------------

const TEST_WRITER_SYSTEM = `You are a test writer agent. Your only job: write a Playwright test for the given test case using the confirmed POMs from the framework graph.

## Tools
framework.getGraph — complete POM inventory (fields, method signatures, fixture status). Call ONCE first — this is your source of truth.
fs.read — read an existing spec file when you need to inspect its current contents.
testData.getSchema — real field names for a dataset. Call BEFORE using testData, never guess field names.
test.createSpec — scaffold a spec file if it doesn't exist.
test.addCase — insert the test into a spec file.
ast.addImport — add non-fixture imports only (type aliases, etc.).

## Rules
GRAPH FIRST: Call framework.getGraph at step 1. Use ONLY the field and method names that appear in the graph output.
TESTDATA: If the test uses credentials or user data:
  a. Call testData.getSchema('users') before writing the body.
  b. CRITICAL: Add 'testData' to the fixtures array in test.addCase.
  c. In the body: const user = testData<{ username: string; password: string }>('users'); (synchronous, no await).
  d. Use exact field names from getSchema — never invent names.
FIXTURES: import { test, expect } comes from pages.fixture.ts (test.createSpec handles this). Never add fixture imports yourself.
  fixtures[] in test.addCase: every page object the body uses, e.g. ["loginPage", "testData"].
  Never use 'new ClassName(page)' inline — use fixture names directly.
METHODS: If the POM graph shows a method for a multi-step action (e.g. login()), call it — never inline fill/click sequences.
ASSERTIONS: Assert what 'Expected' describes. Never write trivial title checks. toBeGreaterThan(0) not toBeGreaterThan({ min: 0 }).
BODY: Write only statements — no surrounding function signature or braces.
  Do NOT call goto() — the fixture auto-navigates to baseURL before the test starts.
BATCH: Combine independent tool calls in one response. Stop after test.addCase succeeds.`;

// ---------------------------------------------------------------------------
// Task prompt
// ---------------------------------------------------------------------------

function buildTestWriterTask(tc: TestCase, specFile: string, locale: string | null): string {
  const isGeneric = locale === null;
  return [
    'Write a Playwright test for this test case.',
    '',
    renderTestCase(tc),
    '',
    `Write the test to: ${specFile}`,
    '',
    'Steps:',
    '  1. Call framework.getGraph — confirms all POMs, fields, methods, and fixture names.',
    isGeneric
      ? '  2. Locale scope is GENERIC — the test runs for every locale. Use common POM field names.'
      : `  2. Locale scope is ${locale}. Use the localeOverrides["${locale}"] fields/methods where they differ.`,
    '  3. If the test uses credentials: call testData.getSchema("users") and note exact field names.',
    '  4. Call test.createSpec if the spec file does not exist.',
    `     ${locale ? 'Pass serial:true (locale-specific specs are always serial).' : 'No serial:true needed for generic specs.'}`,
    '  5. Call test.addCase with the test body.',
    '     fixtures[]: list every page fixture the body uses, plus "testData" if credentials are used.',
    '     body: statements only — do NOT call goto(), the fixture handles navigation automatically.',
    '  6. Stop.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Spec file path inference
// ---------------------------------------------------------------------------

const SPEC_KEYWORDS: Array<[RegExp, string]> = [
  [/register|sign.?up|signup|log.?in|sign.?in|logout|sign.?out|password|credential/i, 'auth'],
  [/cart|basket|bag|wishlist/i, 'cart'],
  [/checkout|payment|order|purchase|billing|shipping/i, 'checkout'],
  [/product|search|filter|categor|listing|catalog/i, 'products'],
  [/contact|form|submit|enquir/i, 'forms'],
  [/home|landing|hero|dashboard/i, 'home'],
  [/profile|account|settings|preference/i, 'account'],
];

function inferSpecFile(tc: TestCase, locale: string | null): string {
  if (tc.specFile) return tc.specFile;
  let base = 'general';
  for (const [pattern, name] of SPEC_KEYWORDS) {
    if (pattern.test(tc.title)) { base = name; break; }
  }
  if (locale) return `tests/locales/${locale}/${base}.spec.ts`;
  return `tests/generic/${base}.spec.ts`;
}

function resolveLocale(localeScope: string | string[]): string | null {
  if (localeScope === 'generic' || localeScope === 'global') return null;
  if (Array.isArray(localeScope)) return localeScope.length > 0 ? localeScope[0] : null;
  return localeScope;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface TestWriterAgentDeps {
  llm: LLMClient;
  toolCtx: ToolContext;
  conversationLog: ConversationLog;
  agentLogger: AgentLogger;
  model: string;
  maxTokens: number;
}

export async function runTestWriterAgent(
  tc: TestCase,
  deps: TestWriterAgentDeps,
): Promise<AgentResult> {
  const { llm, toolCtx, conversationLog, agentLogger, model, maxTokens } = deps;

  const locale = resolveLocale(tc.localeScope ?? 'generic');
  const specFile = inferSpecFile(tc, locale);

  await agentLogger.info('testwriter', 'phase.enter', 0);

  try {
    const result = await runAgent(
      buildTestWriterTask(tc, specFile, locale),
      { maxSteps: 15, model, maxTokens, system: TEST_WRITER_SYSTEM },
      { llm, tools: buildTestWriterRegistry(), toolCtx, state: conversationLog },
    );
    await agentLogger.info('testwriter', 'phase.ok', 0, { steps: result.steps, usage: result.usage });
    return result;
  } catch (err) {
    await agentLogger.error('testwriter', 'phase.error', 0, { message: (err as Error).message });
    throw err;
  }
}
