import { ToolRegistry } from '../tools/registry.js';
import { runAgent } from '../agent/loop.js';
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
import { startPlaywrightMcp } from '../mcp/playwrightServer.js';
import { incrementAttempt, initialState, transition, } from './state.js';
import { fixSystemPrompt, fixTask, generateSystemPrompt, generateTask } from './prompts.js';
/**
 * Build a ToolRegistry scoped to a specific phase. Each phase exposes only
 * the tools that are valid inside it — scope enforcement at the tool surface,
 * not via prompt discipline.
 */
function buildGenerateRegistry(extras = []) {
    const reg = new ToolRegistry();
    reg.register(fsReadTool);
    reg.register(testCreateSpecTool);
    reg.register(testAddCaseTool);
    reg.register(astAddImportTool);
    reg.register(pomUpdateSelectorTool);
    reg.register(pomEditMethodTool);
    for (const t of extras)
        reg.register(t);
    // NOTE: exec.* tools deliberately excluded. The orchestrator runs tests.
    return reg;
}
function buildFixRegistry(extras = []) {
    const reg = new ToolRegistry();
    reg.register(fsReadTool);
    reg.register(testEditCaseTool);
    reg.register(pomUpdateSelectorTool);
    reg.register(pomEditMethodTool);
    reg.register(astAddImportTool);
    for (const t of extras)
        reg.register(t);
    // NOTE: test.createSpec/addCase excluded — fix phase does not create new tests.
    return reg;
}
function buildExecRegistry(cfg) {
    const reg = new ToolRegistry();
    reg.register(createRunTestsTool(cfg.validation));
    reg.register(parseReportTool);
    return reg;
}
export async function runOrchestrator(tc, cfg, deps) {
    const { logger, runState } = deps;
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
    let mcpHandle;
    const browseTools = [];
    if (cfg.browse) {
        try {
            mcpHandle = await startPlaywrightMcp();
            browseTools.push(...mcpHandle.tools);
            await logger.info('init', 'mcp.started', 0, {
                tools: mcpHandle.registeredToolNames,
            });
        }
        catch (err) {
            await logger.warn('init', 'mcp.start_failed', 0, {
                message: err.message,
            });
            // Non-fatal: continue without browse tools. Selector discovery won't be
            // available but the rest of the orchestrator works.
            mcpHandle = undefined;
        }
    }
    try {
        return await runOrchestratorCore(tc, cfg, deps, state, persist, browseTools);
    }
    finally {
        if (mcpHandle) {
            try {
                await mcpHandle.stop();
                await logger.info('done', 'mcp.stopped', 0);
            }
            catch (err) {
                await logger.warn('done', 'mcp.stop_failed', 0, {
                    message: err.message,
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
async function runOrchestratorCore(tc, cfg, deps, initialStateArg, persist, browseTools) {
    const { logger, toolCtx, runState, llm } = deps;
    let state = initialStateArg;
    // --- GENERATE (single attempt; no retry inside phase) ---------------------
    state = incrementAttempt(state);
    state = transition(state, 'generate');
    await logger.info('generate', 'phase.enter', state.attemptsUsed);
    try {
        await runAgent(generateTask(tc, cfg.defaultSpecFile), {
            maxSteps: 20, // per-phase step cap; distinct from orchestrator maxAttempts
            model: cfg.model,
            maxTokens: cfg.maxTokens,
            system: generateSystemPrompt(),
        }, {
            llm,
            tools: buildGenerateRegistry(browseTools),
            toolCtx,
            state: runState,
        });
        await logger.info('generate', 'phase.ok', state.attemptsUsed);
    }
    catch (err) {
        await logger.error('generate', 'phase.error', state.attemptsUsed, {
            message: err.message,
        });
        state = transition(state, 'exhausted', { ok: false, detail: { stage: 'generate', error: err.message } });
        await persist();
        return { finalPhase: 'exhausted', state };
    }
    // --- EXECUTE / ANALYZE / FIX loop ----------------------------------------
    while (true) {
        // EXECUTE
        state = transition(state, 'execute');
        await logger.info('execute', 'phase.enter', state.attemptsUsed);
        const execReg = buildExecRegistry(cfg);
        const runTestsResult = await execReg.dispatch({ id: 'orch.run', name: 'exec.runTests', input: {} }, toolCtx);
        if (!runTestsResult.ok) {
            await logger.error('execute', 'runTests.failed', state.attemptsUsed, {
                error: runTestsResult.error,
            });
            state = transition(state, 'exhausted', { ok: false, detail: runTestsResult });
            await persist();
            return { finalPhase: 'exhausted', state };
        }
        const runTestsOutput = runTestsResult.output;
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
            state = transition(state, 'done');
            await persist();
            await logger.info('done', 'run.success', state.attemptsUsed);
            return { finalPhase: 'done', state };
        }
        // ANALYZE
        state = transition(state, 'analyze');
        await logger.info('analyze', 'phase.enter', state.attemptsUsed);
        const parseResult = await execReg.dispatch({
            id: 'orch.parse',
            name: 'exec.parseReport',
            input: { reportPath: runTestsOutput.reportPath, maxFailures: 1 },
        }, toolCtx);
        if (!parseResult.ok) {
            await logger.error('analyze', 'parseReport.failed', state.attemptsUsed, {
                error: parseResult.error,
            });
            state = transition(state, 'exhausted', { ok: false, detail: parseResult });
            await persist();
            return { finalPhase: 'exhausted', state };
        }
        const parsed = parseResult.output;
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
        // FIX
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
        state = transition(state, 'fix');
        await logger.info('fix', 'phase.enter', state.attemptsUsed, {
            action: classification.action,
            kind: classification.kind,
        });
        try {
            await runAgent(fixTask(failure, classification), {
                maxSteps: 10,
                model: cfg.model,
                maxTokens: cfg.maxTokens,
                system: fixSystemPrompt(),
            }, {
                llm,
                tools: buildFixRegistry(browseTools),
                toolCtx,
                state: runState,
            });
            await logger.info('fix', 'phase.ok', state.attemptsUsed);
        }
        catch (err) {
            await logger.error('fix', 'phase.error', state.attemptsUsed, {
                message: err.message,
            });
            state = transition(state, 'exhausted', {
                ok: false,
                detail: { stage: 'fix', error: err.message },
            });
            await persist();
            return { finalPhase: 'exhausted', state };
        }
        await persist();
        // Loop back to EXECUTE.
    }
}
//# sourceMappingURL=qaAgent.js.map