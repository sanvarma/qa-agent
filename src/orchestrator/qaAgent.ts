import type { LLMClient } from '../llm/client.js';
import type { ToolContext, AnyTool } from '../tools/tool.js';
import { ToolRegistry } from '../tools/registry.js';
import { runAgent } from '../agent/loop.js';
import { ConversationLog } from '../agent/conversationLog.js';

// Tools the orchestrator calls directly (no LLM in the loop).
import { createRunTestsTool } from '../tools/exec/runTests.js';
import { parseReportTool } from '../tools/exec/parseReport.js';
import { classifyFailure } from '../failure/classify.js';

// Tools exposed to the LLM inside generate/fix phases.
import { fsReadTool } from '../tools/fs/read.js';
import { testCreateSpecTool } from '../tools/test/createSpec.js';
import { testAddCaseTool } from '../tools/test/addCase.js';
import { testEditCaseTool } from '../tools/test/editCase.js';
import { pomUpdateSelectorTool } from '../tools/pom/updateSelector.js';
import { pomEditMethodTool } from '../tools/pom/editMethod.js';
import { astAddImportTool } from '../tools/ast/addImport.js';

// MCP-backed tools (browse.*). Started lazily only when cfg.browse is set.
import { startPlaywrightMcp, type PlaywrightMcpHandle } from '../mcp/playwrightServer.js';

import { findTestAcrossSpecs } from '../ast/testScanner.js';
import { resolve } from 'node:path';
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
  generateSystemPrompt,
  generateTask,
} from './prompts.js';

export interface OrchestratorConfig {
  maxFixAttempts: number;           // how many fix cycles before giving up
  maxTokens: number;
  model: string;
  defaultSpecFile: string;          // relative to paths.tests
  locales: string[];
  validation: { command: string; cwd?: string };
  browse?: {
    appUrl: string;
    selectorPreference: string[];
    headed?: boolean;
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

function buildGenerateRegistry(extras: AnyTool[] = []): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(testCreateSpecTool);
  reg.register(testAddCaseTool);
  reg.register(astAddImportTool);
  reg.register(pomUpdateSelectorTool);
  reg.register(pomEditMethodTool);
  for (const t of extras) reg.register(t);
  return reg;
}

function buildFixRegistry(extras: AnyTool[] = []): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(testEditCaseTool);
  reg.register(pomUpdateSelectorTool);
  reg.register(pomEditMethodTool);
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
    if (mcpHandle) {
      try {
        await mcpHandle.stop();
        await logger.info('done', 'mcp.stopped', 0);
      } catch (err) {
        await logger.warn('done', 'mcp.stop_failed', 0, { message: (err as Error).message });
      }
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

  // --- GENERATE ---------------------------------------------------------------
  if (existingTestFile) {
    state = transition(state, 'execute');
  } else {
    state = transition(state, 'generate');
    await logger.info('generate', 'phase.enter', 0);
    try {
      await runAgent(
        generateTask(tc, cfg.defaultSpecFile, cfg.locales),
        { maxSteps: 20, model: cfg.model, maxTokens: cfg.maxTokens, system: generateSystemPrompt(cfg.locales) },
        { llm, tools: buildGenerateRegistry(browseTools), toolCtx, state: runState },
      );
      await logger.info('generate', 'phase.ok', 0);
    } catch (err) {
      await logger.error('generate', 'phase.error', 0, { message: (err as Error).message });
      state = transition(state, 'exhausted', { ok: false, detail: { stage: 'generate', error: (err as Error).message } });
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
      { id: 'orch.run', name: 'exec.runTests', input: {} },
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
      state = transition(state, 'done');
      await persist();
      await logger.info('done', 'run.success', state.fixAttemptsUsed);
      return { finalPhase: 'done', state, existingTestFile };
    }

    // --- ANALYZE --------------------------------------------------------------
    state = transition(state, 'analyze');
    await logger.info('analyze', 'phase.enter', state.fixAttemptsUsed);

    const parseResult = await execReg.dispatch(
      { id: 'orch.parse', name: 'exec.parseReport', input: { reportPath: runOutput.reportPath, maxFailures: 1 } },
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

    if (parsed.failures.length === 0) {
      await logger.warn('analyze', 'no_failures_but_exit_nonzero', state.fixAttemptsUsed, { totals: parsed.totals });
      state = transition(state, 'exhausted', { ok: false, detail: { reason: 'no_failures_but_exit_nonzero', totals: parsed.totals } });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    const failure = parsed.failures[0];
    const classification = await classifyFailure(failure);
    state = { ...state, lastAnalysis: { failure, classification } };
    await logger.info('analyze', 'phase.ok', state.fixAttemptsUsed, {
      kind: classification.kind, action: classification.action,
      confidence: classification.confidence, cause: classification.cause,
    });

    // 'retry' means flake — just re-run without consuming a fix attempt.
    if (classification.action === 'retry') {
      await logger.info('analyze', 'retry.no_fix_needed', state.fixAttemptsUsed);
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
      await runAgent(
        fixTask(failure, classification, state.fixHistory),
        { maxSteps: 10, model: cfg.model, maxTokens: cfg.maxTokens, system: fixSystemPrompt(cfg.locales) },
        { llm, tools: buildFixRegistry(browseTools), toolCtx, state: runState },
      );
      await logger.info('fix', 'phase.ok', state.fixAttemptsUsed);
    } catch (err) {
      await logger.error('fix', 'phase.error', state.fixAttemptsUsed, { message: (err as Error).message });
      state = transition(state, 'exhausted', { ok: false, detail: { stage: 'fix', error: (err as Error).message } });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    await persist();
    // Loop back to EXECUTE.
  }
}
