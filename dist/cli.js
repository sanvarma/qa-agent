#!/usr/bin/env node
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runAgent } from './agent/loop.js';
import { RunState, newRunId } from './state/run.js';
import { ToolRegistry } from './tools/registry.js';
import { fsReadTool } from './tools/fs/read.js';
import { createRunTestsTool } from './tools/exec/runTests.js';
import { parseReportTool } from './tools/exec/parseReport.js';
import { failureClassifyTool } from './tools/failure/classify.js';
import { testFindCaseTool } from './tools/test/findCase.js';
import { testEditCaseTool } from './tools/test/editCase.js';
import { testAddCaseTool } from './tools/test/addCase.js';
import { testCreateSpecTool } from './tools/test/createSpec.js';
import { pomUpdateSelectorTool } from './tools/pom/updateSelector.js';
import { pomEditMethodTool } from './tools/pom/editMethod.js';
import { astAddImportTool } from './tools/ast/addImport.js';
import { MockLLMClient } from './llm/mockClient.js';
import { ScriptedQaClient } from './llm/scriptedQaClient.js';
import { loadConfig } from './config/config.js';
import { runOrchestrator } from './orchestrator/qaAgent.js';
import { OrchestratorLogger } from './orchestrator/logger.js';
import { loadTestCase } from './orchestrator/testCase.js';
function parseArgs(argv) {
    const sub = argv[0];
    if (sub !== 'run' && sub !== 'qa') {
        throw new Error(`usage: qa-agent <run|qa> [options]\n` +
            `  run --task <text> --repo <path> [--llm mock]\n` +
            `  qa  --testcase <path> --repo <path> [--llm scripted|mock]`);
    }
    const rest = argv.slice(1);
    if (sub === 'run') {
        const args = { subcommand: 'run', llm: 'mock' };
        for (let i = 0; i < rest.length; i++) {
            const a = rest[i];
            if (a === '--task')
                args.task = rest[++i];
            else if (a === '--repo')
                args.repo = rest[++i];
            else if (a === '--llm')
                args.llm = rest[++i];
        }
        if (!args.task)
            throw new Error('run: --task is required');
        if (!args.repo)
            throw new Error('run: --repo is required');
        return args;
    }
    const args = { subcommand: 'qa', llm: 'scripted' };
    for (let i = 0; i < rest.length; i++) {
        const a = rest[i];
        if (a === '--testcase')
            args.testcase = rest[++i];
        else if (a === '--repo')
            args.repo = rest[++i];
        else if (a === '--llm')
            args.llm = rest[++i];
    }
    if (!args.testcase)
        throw new Error('qa: --testcase is required');
    if (!args.repo)
        throw new Error('qa: --repo is required');
    return args;
}
function buildLLM(kind) {
    switch (kind) {
        case 'mock':
            // Scripted plan: read package.json, then stop. Proves the loop end-to-end.
            return new MockLLMClient([
                {
                    text: 'I will inspect the repo by reading package.json.',
                    toolCalls: [
                        { id: 'call_1', name: 'fs.read', input: { path: 'package.json' } },
                    ],
                    stopReason: 'tool_use',
                },
                {
                    text: 'Done. I have the file contents.',
                    toolCalls: [],
                    stopReason: 'end_turn',
                },
            ]);
    }
}
function buildQaLLM(kind) {
    switch (kind) {
        case 'scripted':
            return new ScriptedQaClient();
        case 'mock':
            // Empty script — the orchestrator still runs its deterministic phases,
            // but generate/fix phases emit no tool calls. Useful for wiring tests.
            return new MockLLMClient([]);
    }
}
async function runGeneric(args) {
    const repoRoot = resolve(args.repo);
    const cfg = await loadConfig(repoRoot);
    const tools = new ToolRegistry();
    tools.register(fsReadTool);
    tools.register(createRunTestsTool({ command: cfg.validation.command, cwd: cfg.validation.cwd }));
    tools.register(parseReportTool);
    tools.register(failureClassifyTool);
    tools.register(testFindCaseTool);
    tools.register(testEditCaseTool);
    tools.register(testAddCaseTool);
    tools.register(testCreateSpecTool);
    tools.register(pomUpdateSelectorTool);
    tools.register(pomEditMethodTool);
    tools.register(astAddImportTool);
    const runId = newRunId();
    const runDir = resolve(repoRoot, '.qa-agent', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    const state = new RunState({
        id: runId,
        task: args.task,
        repoRoot,
        model: cfg.model,
        startedAt: new Date().toISOString(),
    }, runDir);
    const llm = buildLLM(args.llm);
    const result = await runAgent(args.task, {
        maxSteps: cfg.maxSteps,
        model: cfg.model,
        maxTokens: cfg.maxTokens,
        system: 'You are a QA automation agent. Use the provided tools to inspect the repo. ' +
            'Prefer small, targeted reads. Stop as soon as the task is complete.',
    }, { llm, tools, toolCtx: { repoRoot, runDir, paths: cfg.paths }, state });
    await state.persist();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({ runId, stopReason: result.stopReason, steps: result.steps, runDir }, null, 2));
}
async function runQa(args) {
    const repoRoot = resolve(args.repo);
    const cfg = await loadConfig(repoRoot);
    const testCase = await loadTestCase(resolve(args.testcase));
    const runId = newRunId();
    const runDir = resolve(repoRoot, '.qa-agent', 'runs', runId);
    await mkdir(runDir, { recursive: true });
    // RunState is shared across all runAgent() invocations inside the orchestrator.
    // The orchestrator persists it after each phase.
    const runState = new RunState({
        id: runId,
        task: `qa: ${testCase.title}`,
        repoRoot,
        model: cfg.model,
        startedAt: new Date().toISOString(),
    }, runDir);
    const logger = new OrchestratorLogger(runDir, runId);
    const llm = buildQaLLM(args.llm);
    const result = await runOrchestrator(testCase, {
        maxAttempts: cfg.maxSteps, // reusing maxSteps as the attempt budget for now
        maxTokens: cfg.maxTokens,
        model: cfg.model,
        defaultSpecFile: 'tests/agent-generated.spec.ts',
        validation: { command: cfg.validation.command, cwd: cfg.validation.cwd },
        browse: cfg.browse,
    }, {
        llm,
        toolCtx: { repoRoot, runDir, paths: cfg.paths },
        runState,
        logger,
    });
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
        runId,
        finalPhase: result.finalPhase,
        attemptsUsed: result.state.attemptsUsed,
        runDir,
    }, null, 2));
}
async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.subcommand === 'run') {
        await runGeneric(args);
    }
    else {
        await runQa(args);
    }
}
main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err instanceof Error ? err.stack ?? err.message : err);
    process.exit(1);
});
//# sourceMappingURL=cli.js.map