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
  incrementAttempt,
  initialState,
  transition,
} from './state.js';
import {
  fixSystemPrompt,
  fixTask,
  generateSystemPrompt,
  generateTask,
  regenerateSystemPrompt,
  regenerateTask,
} from './prompts.js';

export interface OrchestratorConfig {
  maxAttempts: number;
  maxTokens: number;
  model: string;
  defaultSpecFile: string;              // relative to paths.tests
  locales: string[];                    // active locales; drives locale-aware prompt context
  // After this many consecutive failed fix attempts the orchestrator switches to
  // the regenerate phase instead of another fix. Defaults to 2.
  maxConsecutiveFixFailures: number;
  validation: { command: string; cwd?: string };
  // Optional: enables Playwright MCP discovery during generate/fix phases.
  // Presence of this block triggers MCP server startup.
  browse?: {
    appUrl: string;
    selectorPreference: string[];
    headed?: boolean;
  };
}

export interface OrchestratorDeps {
  llm: LLMClient;
  toolCtx: ToolContext;
  conversationLog: ConversationLog;                   // generic tool-use loop's state; re-used across sub-calls
  agentLogger: AgentLogger;
}

export interface OrchestratorResult {
  finalPhase: Extract<Phase, 'done' | 'exhausted'>;
  state: OrchestratorState;
  // Set when the test title already existed in the repo — generation was skipped
  // and the orchestrator went straight to EXECUTE to verify it still passes.
  existingTestFile?: string;
}

/**
 * Build a ToolRegistry scoped to a specific phase. Each phase exposes only
 * the tools that are valid inside it — scope enforcement at the tool surface,
 * not via prompt discipline.
 */
function buildGenerateRegistry(extras: AnyTool[] = []): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(testCreateSpecTool);
  reg.register(testAddCaseTool);
  reg.register(astAddImportTool);
  reg.register(pomUpdateSelectorTool);
  reg.register(pomEditMethodTool);
  for (const t of extras) reg.register(t);
  // NOTE: exec.* tools deliberately excluded. The orchestrator runs tests.
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
  // NOTE: test.createSpec/addCase excluded — fix phase does not create new tests.
  return reg;
}

function buildRegenerateRegistry(extras: AnyTool[] = []): ToolRegistry {
  // Regenerate has the full generate toolset plus editCase — it may need to
  // rewrite an existing test body rather than create a new spec from scratch.
  const reg = new ToolRegistry();
  reg.register(fsReadTool);
  reg.register(testEditCaseTool);
  reg.register(testCreateSpecTool);
  reg.register(testAddCaseTool);
  reg.register(astAddImportTool);
  reg.register(pomUpdateSelectorTool);
  reg.register(pomEditMethodTool);
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
  const state = initialState(runState.meta.id, cfg.maxAttempts);

  const persist = async () => {
    await runState.persist();
  };

  await logger.info('init', 'run.start', 0, {
    testCase: tc.title,
    maxAttempts: cfg.maxAttempts,
    browseEnabled: cfg.browse !== undefined,
  });

  // --- MCP startup (optional, config-gated) --------------------------------
  // Started here so the subprocess lives for the whole run. startPlaywrightMcp
  // returns federated tools we register into the per-phase registries below.
  let mcpHandle: PlaywrightMcpHandle | undefined;
  const browseTools: AnyTool[] = [];
  if (cfg.browse) {
    try {
      mcpHandle = await startPlaywrightMcp({
        // Playwright MCP runs headed by default. Opt out with --headless.
        extraArgs: cfg.browse.headed ? [] : ['--headless'],
      });
      browseTools.push(...mcpHandle.tools);
      await logger.info('init', 'mcp.started', 0, {
        tools: mcpHandle.registeredToolNames,
        headed: cfg.browse.headed === true,
      });
    } catch (err) {
      await logger.warn('init', 'mcp.start_failed', 0, {
        message: (err as Error).message,
      });
      // Non-fatal: continue without browse tools. Selector discovery won't be
      // available but the rest of the orchestrator works.
      mcpHandle = undefined;
    }
  }

  // Pre-flight: check if a test with this title already exists anywhere under tests/.
  // If so, skip generation and go straight to EXECUTE so we verify it still passes.
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
        await logger.warn('done', 'mcp.stop_failed', 0, {
          message: (err as Error).message,
        });
      }
    }
  }
}

/**
 * Core orchestrator loop. Extracted so `runOrchestrator` can own MCP
 * lifecycle (start before, stop in finally) without deeply indenting the
 * state machine below.
 */
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

  // --- GENERATE (skipped when the test already exists in the repo) ----------
  if (existingTestFile) {
    // Jump straight to EXECUTE — just verify the existing test still passes.
    state = transition(state, 'execute');
  } else {
    state = incrementAttempt(state);
    state = transition(state, 'generate');
    await logger.info('generate', 'phase.enter', state.attemptsUsed);

    try {
      await runAgent(
        generateTask(tc, cfg.defaultSpecFile, cfg.locales),
        {
          maxSteps: 20,         // per-phase step cap; distinct from orchestrator maxAttempts
          model: cfg.model,
          maxTokens: cfg.maxTokens,
          system: generateSystemPrompt(cfg.locales),
        },
        {
          llm,
          tools: buildGenerateRegistry(browseTools),
          toolCtx,
          state: runState,
        },
      );
      await logger.info('generate', 'phase.ok', state.attemptsUsed);
    } catch (err) {
      await logger.error('generate', 'phase.error', state.attemptsUsed, {
        message: (err as Error).message,
      });
      state = transition(state, 'exhausted', { ok: false, detail: { stage: 'generate', error: (err as Error).message } });
      await persist();
      return { finalPhase: 'exhausted', state };
    }
  }

  // --- EXECUTE / ANALYZE / FIX loop ----------------------------------------
  while (true) {
    // EXECUTE — transition only when not already in execute (skip-generate lands here directly)
    if (state.phase !== 'execute') {
      state = transition(state, 'execute');
    }
    await logger.info('execute', 'phase.enter', state.attemptsUsed);

    const execReg = buildExecRegistry(cfg);
    const runTestsResult = await execReg.dispatch(
      { id: 'orch.run', name: 'exec.runTests', input: {} },
      toolCtx,
    );
    if (!runTestsResult.ok) {
      await logger.error('execute', 'runTests.failed', state.attemptsUsed, {
        error: runTestsResult.error,
      });
      state = transition(state, 'exhausted', { ok: false, detail: runTestsResult });
      await persist();
      return { finalPhase: 'exhausted', state };
    }
    const runTestsOutput = runTestsResult.output as {
      success: boolean;
      reportPath: string;
      exitCode: number | null;
      durationMs: number;
    };
    state = {
      ...state,
      lastExecution: {
        success: runTestsOutput.success,
        reportPath: runTestsOutput.reportPath,
        exitCode: runTestsOutput.exitCode,
        durationMs: runTestsOutput.durationMs,
      },
    };
    await logger.info('execute', 'phase.ok', state.attemptsUsed, {
      success: runTestsOutput.success,
      exitCode: runTestsOutput.exitCode,
    });

    if (runTestsOutput.success) {
      state = { ...state, consecutiveFixFailures: 0 };
      state = transition(state, 'done');
      await persist();
      await logger.info('done', 'run.success', state.attemptsUsed);
      return { finalPhase: 'done', state, existingTestFile };
    }

    // ANALYZE
    state = transition(state, 'analyze');
    await logger.info('analyze', 'phase.enter', state.attemptsUsed);

    const parseResult = await execReg.dispatch(
      {
        id: 'orch.parse',
        name: 'exec.parseReport',
        input: { reportPath: runTestsOutput.reportPath, maxFailures: 1 },
      },
      toolCtx,
    );
    if (!parseResult.ok) {
      await logger.error('analyze', 'parseReport.failed', state.attemptsUsed, {
        error: parseResult.error,
      });
      state = transition(state, 'exhausted', { ok: false, detail: parseResult });
      await persist();
      return { finalPhase: 'exhausted', state };
    }
    const parsed = parseResult.output as {
      totals: { passed: number; failed: number; skipped: number; flaky: number };
      failures: Array<{
        testTitle: string;
        file: string;
        line?: number;
        column?: number;
        status: 'failed' | 'timedOut' | 'interrupted';
        message: string;
        rawSnippet: string;
      }>;
    };

    if (parsed.failures.length === 0) {
      // exitCode was non-zero but no failures in report — abnormal run (e.g., config error).
      await logger.warn('analyze', 'no_failures_but_exit_nonzero', state.attemptsUsed, {
        totals: parsed.totals,
      });
      state = transition(state, 'exhausted', {
        ok: false,
        detail: { reason: 'no_failures_but_exit_nonzero', totals: parsed.totals },
      });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    const failure = parsed.failures[0];
    const classification = await classifyFailure(failure);
    state = { ...state, lastAnalysis: { failure, classification } };
    await logger.info('analyze', 'phase.ok', state.attemptsUsed, {
      kind: classification.kind,
      action: classification.action,
      confidence: classification.confidence,
      cause: classification.cause,
    });

    // Retry-kinds short-circuit the fix phase entirely.
    // We treat 'retry' as "just run again, maybe it was flake", but still count
    // it against maxAttempts so we can't loop forever on real failures.
    if (classification.action === 'retry') {
      state = incrementAttempt(state);
      if (state.attemptsUsed > state.maxAttempts) {
        await logger.warn('analyze', 'budget.exhausted', state.attemptsUsed, {
          maxAttempts: state.maxAttempts,
          action: 'retry',
        });
        state = transition(state, 'exhausted', {
          ok: false,
          detail: { reason: 'budget_exhausted_during_retry', classification },
        });
        await persist();
        return { finalPhase: 'exhausted', state };
      }
      await logger.info('analyze', 'retry.no_fix_needed', state.attemptsUsed);
      await persist();
      continue; // back to EXECUTE
    }

    // Record this failure in the fix history before deciding what to do with it.
    const fixAttempt: FixAttempt = {
      attemptNumber: state.attemptsUsed,
      failure,
      classification,
    };
    state = {
      ...state,
      fixHistory: [...state.fixHistory, fixAttempt],
      consecutiveFixFailures: state.consecutiveFixFailures + 1,
    };

    state = incrementAttempt(state);
    if (state.attemptsUsed > state.maxAttempts) {
      await logger.warn('analyze', 'budget.exhausted', state.attemptsUsed, {
        maxAttempts: state.maxAttempts,
      });
      state = transition(state, 'exhausted', {
        ok: false,
        detail: { reason: 'budget_exhausted_before_fix', classification },
      });
      await persist();
      return { finalPhase: 'exhausted', state };
    }

    // Switch to REGENERATE when the fix loop is spinning without progress.
    const shouldRegenerate =
      state.consecutiveFixFailures >= cfg.maxConsecutiveFixFailures;

    if (shouldRegenerate) {
      // REGENERATE
      state = transition(state, 'regenerate');
      await logger.info('regenerate', 'phase.enter', state.attemptsUsed, {
        consecutiveFixFailures: state.consecutiveFixFailures,
        fixHistoryLength: state.fixHistory.length,
      });

      try {
        await runAgent(
          regenerateTask(tc, failure, state.fixHistory, cfg.locales),
          {
            maxSteps: 20,
            model: cfg.model,
            maxTokens: cfg.maxTokens,
            system: regenerateSystemPrompt(cfg.locales),
          },
          {
            llm,
            tools: buildRegenerateRegistry(browseTools),
            toolCtx,
            state: runState,
          },
        );
        await logger.info('regenerate', 'phase.ok', state.attemptsUsed);
      } catch (err) {
        await logger.error('regenerate', 'phase.error', state.attemptsUsed, {
          message: (err as Error).message,
        });
        state = transition(state, 'exhausted', {
          ok: false,
          detail: { stage: 'regenerate', error: (err as Error).message },
        });
        await persist();
        return { finalPhase: 'exhausted', state };
      }

      // Reset the consecutive counter — regenerate is a fresh start.
      state = { ...state, consecutiveFixFailures: 0 };
    } else {
      // FIX
      state = transition(state, 'fix');
      await logger.info('fix', 'phase.enter', state.attemptsUsed, {
        action: classification.action,
        kind: classification.kind,
        attempt: state.consecutiveFixFailures,
        maxConsecutive: cfg.maxConsecutiveFixFailures,
      });

      try {
        await runAgent(
          fixTask(failure, classification, state.fixHistory),
          {
            maxSteps: 10,
            model: cfg.model,
            maxTokens: cfg.maxTokens,
            system: fixSystemPrompt(cfg.locales),
          },
          {
            llm,
            tools: buildFixRegistry(browseTools),
            toolCtx,
            state: runState,
          },
        );
        await logger.info('fix', 'phase.ok', state.attemptsUsed);
      } catch (err) {
        await logger.error('fix', 'phase.error', state.attemptsUsed, {
          message: (err as Error).message,
        });
        state = transition(state, 'exhausted', {
          ok: false,
          detail: { stage: 'fix', error: (err as Error).message },
        });
        await persist();
        return { finalPhase: 'exhausted', state };
      }
    }

    await persist();
    // Loop back to EXECUTE.
  }
}
