import type { LLMClient } from '../llm/client.js';
import type { ToolContext, AnyTool } from '../tools/tool.js';
import { ToolRegistry } from '../tools/registry.js';
import { runAgent } from '../agent/loop.js';
import { ConversationLog } from '../agent/conversationLog.js';

// Tools the orchestrator calls directly (no LLM in the loop).
import { createRunTestsTool } from '../tools/exec/runTests.js';
import { parseReportTool } from '../tools/exec/parseReport.js';
import { classifyFailure } from '../failure/classify.js';

// Tools exposed to the LLM inside fix phase.
import { fsReadTool } from '../tools/fs/read.js';
import { testEditCaseTool } from '../tools/test/editCase.js';
import { pomCreatePageTool } from '../tools/pom/createPage.js';
import { pomUpdateSelectorTool } from '../tools/pom/updateSelector.js';
import { pomEditMethodTool } from '../tools/pom/editMethod.js';
import { pomAddSelectorTool } from '../tools/pom/addSelector.js';
import { fixtureAddPageTool } from '../tools/fixture/addPage.js';
import { astAddImportTool } from '../tools/ast/addImport.js';

// MCP-backed tools (browse.*). Started lazily only when cfg.browse is set.
import { startPlaywrightMcp, type PlaywrightMcpHandle } from '../mcp/playwrightServer.js';

// Multi-agent generate: POM Agent → Test Writer Agent
import { runPomAgent } from './agents/pomAgent.js';
import { runTestWriterAgent } from './agents/testWriterAgent.js';
import { closeAllSessions } from '../tools/browser/session.js';

import { findTestAcrossSpecs } from '../ast/testScanner.js';
import { generateRunViewerHtml } from '../agent/runViewer.js';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { TestCase } from './testCase.js';
import type { AgentLogger } from './logger.js';
import {
  type FixAttempt,
  type OrchestratorState,
  type Phase,
  initialState,
  transition,
} from './state.js';
import {
  fixSystemPrompt,
  fixTask,
} from './agents/fixPrompts.js';

export interface OrchestratorConfig {
  maxFixAttempts: number;           // how many fix cycles before giving up
  maxRetryAttempts: number;         // how many classifier 'retry' loops before giving up
  maxTokens: number;
  model: string;
  defaultSpecFile: string;          // relative to paths.tests
  validation: { command: string; cwd?: string };
  browse?: {
    baseUrl: string;
    selectorPreference: string[];
    headed?: boolean;
    email?: string;
    password?: string;
    maxSnapshotLines?: number;
  };
}

export interface OrchestratorDeps {
  llm: LLMClient;
  toolCtx: ToolContext;
  conversationLog: ConversationLog;
  agentLogger: AgentLogger;
}

export interface OrchestratorResult {
  finalPhase: Extract<Phase, 'done' | 'exhausted'>;
  state: OrchestratorState;
  existingTestFile?: string;
}

function buildFixRegistry(extras: AnyTool[] = []): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(testEditCaseTool);
  reg.register(pomCreatePageTool);
  reg.register(pomUpdateSelectorTool);
  reg.register(pomAddSelectorTool);
  reg.register(pomEditMethodTool);
  reg.register(fixtureAddPageTool);
  reg.register(astAddImportTool);
  for (const t of extras) reg.register(t);
  return reg;
}

function buildExecRegistry(cfg: OrchestratorConfig): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(createRunTestsTool(cfg.validation));
  reg.register(parseReportTool);
  return reg;
}

export async function runOrchestrator(
  tc: TestCase,
  cfg: OrchestratorConfig,
  deps: OrchestratorDeps,
): Promise<OrchestratorResult> {
  const { agentLogger: logger, conversationLog: runState } = deps;
  const state = initialState(runState.meta.id);

  const persist = async () => { await runState.persist(); };

  await logger.info('init', 'run.start', 0, {
    testCase: tc.title,
    maxFixAttempts: cfg.maxFixAttempts,
    browseEnabled: cfg.browse !== undefined,
  });

  // --- MCP startup (optional, config-gated) ----------------------------------
  let mcpHandle: PlaywrightMcpHandle | undefined;
  const browseTools: AnyTool[] = [];
  if (cfg.browse) {
    try {
      mcpHandle = await startPlaywrightMcp({
        extraArgs: cfg.browse.headed ? [] : ['--headless'],
        maxSnapshotLines: cfg.browse.maxSnapshotLines,
      });
      browseTools.push(...mcpHandle.tools);
      await logger.info('init', 'mcp.started', 0, {
        tools: mcpHandle.registeredToolNames,
        headed: cfg.browse.headed === true,
      });
    } catch (err) {
      await logger.warn('init', 'mcp.start_failed', 0, { message: (err as Error).message });
    }
  }

  // Pre-flight: skip generate if the test title already exists in the repo.
  const testsDir = resolve(deps.toolCtx.repoRoot, deps.toolCtx.paths?.tests ?? 'tests');
  const existing = findTestAcrossSpecs(tc.title, testsDir, deps.toolCtx.repoRoot);
  if (existing) {
    await logger.info('init', 'generate.skipped', 0, {
      reason: 'test_already_exists',
      foundAt: existing.repoRelativePath,
    });
  }

  try {
    return await runOrchestratorCore(tc, cfg, deps, state, persist, browseTools, existing?.repoRelativePath);
  } finally {
    // Close any browser sessions left open by the POM Agent.
    await closeAllSessions().catch(() => undefined);

    if (mcpHandle) {
      try {
        await mcpHandle.stop();
        await logger.info('done', 'mcp.stopped', 0);
      } catch (err) {
        await logger.warn('done', 'mcp.stop_failed', 0, { message: (err as Error).message });
      }
    }
    try {
      const dir = deps.conversationLog.dir;
      const readAgent = async (sub: string) => {
        try { return JSON.parse(await readFile(join(dir, sub, 'run.json'), 'utf8')); } catch { return undefined; }
      };
      const [pomData, twData] = await Promise.all([readAgent('pom'), readAgent('testwriter')]);
      const html = generateRunViewerHtml(
        deps.conversationLog.meta,
        deps.conversationLog.turns,
        deps.agentLogger.events,
        { pom: pomData, testwriter: twData },
      );
      await writeFile(join(dir, 'run-viewer.html'), html, 'utf8');
    } catch {
      // non-fatal: viewer generation failure shouldn't break the run
    }
  }
}

async function runOrchestratorCore(
  tc: TestCase,
  cfg: OrchestratorConfig,
  deps: OrchestratorDeps,
  initialStateArg: OrchestratorState,
  persist: () => Promise<void>,
  browseTools: AnyTool[],
  existingTestFile: string | undefined,
): Promise<OrchestratorResult> {
  const { agentLogger: logger, toolCtx, conversationLog: runState, llm } = deps;
  let state = initialStateArg;

  // --- GENERATE (POM Agent → Test Writer Agent) --------------------------------
  if (existingTestFile) {
    state = transition(state, 'execute');
  } else {
    state = transition(state, 'generate');

    const baseUrl = cfg.browse?.baseUrl ?? 'https://localhost';

    // Each sub-agent gets its own ConversationLog so their context stays small.
    // Sub-logs are persisted alongside the main run log.
    const pomLog = new ConversationLog(
      { ...runState.meta, task: `pom: ${tc.title}` },
      join(runState.dir, 'pom'),
    );
    const twLog = new ConversationLog(
      { ...runState.meta, task: `testwriter: ${tc.title}` },
      join(runState.dir, 'testwriter'),
    );

    // --- POM phase -----------------------------------------------------------
    try {
      const pomResult = await runPomAgent(tc, baseUrl, {
        llm,
        toolCtx,
        conversationLog: pomLog,
        agentLogger: logger,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
      });
      await pomLog.persist();
      if (pomResult.stopReason === 'max_tokens' || pomResult.stopReason === 'max_steps') {
        await logger.warn('pom', 'phase.budget_exhausted', 0, { stopReason: pomResult.stopReason, steps: pomResult.steps });
        state = transition(state, 'exhausted', { ok: false, detail: { stage: 'pom', stopReason: pomResult.stopReason } });
        await persist();
        return { finalPhase: 'exhausted', state };
      }
    } catch (err) {
      await pomLog.persist().catch(() => undefined);
      await logger.error('pom', 'phase.error', 0, { message: (err as Error).message });
      state = transition(state, 'exhausted', { ok: false, detail: { stage: 'pom', error: (err as Error).message } });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    // --- Test Writer phase ---------------------------------------------------
    try {
      const twResult = await runTestWriterAgent(tc, {
        llm,
        toolCtx,
        conversationLog: twLog,
        agentLogger: logger,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
      });
      await twLog.persist();
      if (twResult.stopReason === 'max_tokens' || twResult.stopReason === 'max_steps') {
        await logger.warn('testwriter', 'phase.budget_exhausted', 0, { stopReason: twResult.stopReason, steps: twResult.steps });
        state = transition(state, 'exhausted', { ok: false, detail: { stage: 'testwriter', stopReason: twResult.stopReason } });
        await persist();
        return { finalPhase: 'exhausted', state };
      }
    } catch (err) {
      await twLog.persist().catch(() => undefined);
      await logger.error('testwriter', 'phase.error', 0, { message: (err as Error).message });
      state = transition(state, 'exhausted', { ok: false, detail: { stage: 'testwriter', error: (err as Error).message } });
      await persist();
      return { finalPhase: 'exhausted', state };
    }
  }

  // --- EXECUTE / ANALYZE / FIX loop ------------------------------------------
  while (true) {
    if (state.phase !== 'execute') state = transition(state, 'execute');
    await logger.info('execute', 'phase.enter', state.fixAttemptsUsed);

    const execReg = buildExecRegistry(cfg);
    const runResult = await execReg.dispatch(
      { id: 'orch.run', name: 'exec.runTests', input: { grep: tc.title } },
      toolCtx,
    );
    if (!runResult.ok) {
      await logger.error('execute', 'runTests.failed', state.fixAttemptsUsed, { error: runResult.error });
      state = transition(state, 'exhausted', { ok: false, detail: runResult });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    const runOutput = runResult.output as {
      success: boolean; reportPath: string; exitCode: number | null; durationMs: number;
    };
    state = { ...state, lastExecution: { success: runOutput.success, reportPath: runOutput.reportPath, exitCode: runOutput.exitCode, durationMs: runOutput.durationMs } };
    await logger.info('execute', 'phase.ok', state.fixAttemptsUsed, { success: runOutput.success, exitCode: runOutput.exitCode });

    if (runOutput.success) {
      // Parse the report even on success to verify at least one test ran.
      // A zero-test run (no spec file generated, or grep matched nothing) exits
      // with code 0 but is not a real pass — treat it as exhausted.
      const successParseResult = await execReg.dispatch(
        { id: 'orch.parse.success', name: 'exec.parseReport', input: { reportPath: runOutput.reportPath, maxFailures: 1 } },
        toolCtx,
      );
      const successTotals = successParseResult.ok
        ? (successParseResult.output as { totals: { passed: number; failed: number; skipped: number; flaky: number } }).totals
        : null;

      if (!successTotals || (successTotals.passed + successTotals.flaky) === 0) {
        await logger.warn('execute', 'run.no_tests_ran', state.fixAttemptsUsed, {
          totals: successTotals,
          reason: 'playwright exited 0 but no tests passed — spec file likely missing',
        });
        state = transition(state, 'exhausted', {
          ok: false,
          detail: { reason: 'no_tests_ran', totals: successTotals },
        });
        await persist();
        return { finalPhase: 'exhausted', state };
      }

      state = transition(state, 'done');
      await persist();
      await logger.info('done', 'run.success', state.fixAttemptsUsed);
      return { finalPhase: 'done', state, existingTestFile };
    }

    // --- ANALYZE --------------------------------------------------------------
    state = transition(state, 'analyze');
    await logger.info('analyze', 'phase.enter', state.fixAttemptsUsed);

    const parseResult = await execReg.dispatch(
      { id: 'orch.parse', name: 'exec.parseReport', input: { reportPath: runOutput.reportPath, maxFailures: 50 } },
      toolCtx,
    );
    if (!parseResult.ok) {
      await logger.error('analyze', 'parseReport.failed', state.fixAttemptsUsed, { error: parseResult.error });
      state = transition(state, 'exhausted', { ok: false, detail: parseResult });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    const parsed = parseResult.output as {
      totals: { passed: number; failed: number; skipped: number; flaky: number };
      failures: Array<{ testTitle: string; file: string; line?: number; column?: number; status: 'failed' | 'timedOut' | 'interrupted'; message: string; rawSnippet: string }>;
    };

    // Filter to failures that belong to our test case specifically.
    // Other tests in the suite may fail — that is not this orchestrator's concern.
    // testTitle in the report may be prefixed by a describe block, e.g. "My Suite > my test".
    const myFailures = parsed.failures.filter(
      (f) => f.testTitle === tc.title || f.testTitle.endsWith(`> ${tc.title}`),
    );

    if (myFailures.length === 0) {
      // Our test passed; other tests may have failed but we don't own them.
      state = transition(state, 'done');
      await persist();
      await logger.info('done', 'run.success', state.fixAttemptsUsed, {
        note: 'managed_test_passed_suite_had_other_failures',
        totals: parsed.totals,
      });
      return { finalPhase: 'done', state, existingTestFile };
    }

    const failure = myFailures[0];
    const classification = await classifyFailure(failure);
    state = { ...state, lastAnalysis: { failure, classification } };
    await logger.info('analyze', 'phase.ok', state.fixAttemptsUsed, {
      kind: classification.kind, action: classification.action,
      confidence: classification.confidence, cause: classification.cause,
    });

    // 'retry' means flake — just re-run without consuming a fix attempt.
    // Guard against infinite retry loops with a hard cap.
    if (classification.action === 'retry') {
      state = { ...state, retryAttemptsUsed: state.retryAttemptsUsed + 1 };
      if (state.retryAttemptsUsed >= cfg.maxRetryAttempts) {
        await logger.warn('analyze', 'retry.budget_exhausted', state.fixAttemptsUsed, {
          maxRetryAttempts: cfg.maxRetryAttempts,
          retryAttemptsUsed: state.retryAttemptsUsed,
          kind: classification.kind,
          cause: classification.cause,
        });
        state = transition(state, 'exhausted', {
          ok: false,
          detail: { reason: 'retry_budget_exhausted', retryAttemptsUsed: state.retryAttemptsUsed, classification },
        });
        await persist();
        return { finalPhase: 'exhausted', state };
      }
      await logger.info('analyze', 'retry.no_fix_needed', state.fixAttemptsUsed, {
        retryAttemptsUsed: state.retryAttemptsUsed,
        maxRetryAttempts: cfg.maxRetryAttempts,
      });
      await persist();
      continue;
    }

    // Check fix budget before entering fix phase.
    if (state.fixAttemptsUsed >= cfg.maxFixAttempts) {
      await logger.warn('analyze', 'fix.budget_exhausted', state.fixAttemptsUsed, {
        maxFixAttempts: cfg.maxFixAttempts,
        lastFailure: failure.message.split('\n')[0],
      });
      state = transition(state, 'exhausted', {
        ok: false,
        detail: { reason: 'fix_budget_exhausted', fixAttemptsUsed: state.fixAttemptsUsed, classification },
      });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    // --- FIX ------------------------------------------------------------------
    const fixAttempt: FixAttempt = {
      fixNumber: state.fixAttemptsUsed + 1,
      failure,
      classification,
    };
    state = {
      ...state,
      fixHistory: [...state.fixHistory, fixAttempt],
      fixAttemptsUsed: state.fixAttemptsUsed + 1,
    };
    state = transition(state, 'fix');
    await logger.info('fix', 'phase.enter', state.fixAttemptsUsed, {
      action: classification.action,
      kind: classification.kind,
      fixAttempt: state.fixAttemptsUsed,
      maxFixAttempts: cfg.maxFixAttempts,
    });

    try {
      const fixResult = await runAgent(
        fixTask(failure, classification, state.fixHistory),
        { maxSteps: 10, model: cfg.model, maxTokens: cfg.maxTokens, system: fixSystemPrompt(cfg.browse) },
        { llm, tools: buildFixRegistry(browseTools), toolCtx, state: runState },
      );
      await logger.info('fix', 'phase.ok', state.fixAttemptsUsed, { steps: fixResult.steps, usage: fixResult.usage });
    } catch (err) {
      // Transient error (e.g. LLM fetch failed). The fix attempt was already
      // counted above, so the budget is still consumed. Don't exhaust here —
      // loop back to execute so the next run can determine if a fix is still
      // needed, and if so, the budget check in analyze will gate further retries.
      await logger.error('fix', 'phase.error', state.fixAttemptsUsed, { message: (err as Error).message });
    }

    await persist();
    // Loop back to EXECUTE.
  }
}
