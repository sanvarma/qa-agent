#!/usr/bin/env node
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { runAgent } from './agent/loop.js';
import { ConversationLog, newRunId } from './agent/conversationLog.js';
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
import { OllamaClient } from './llm/ollamaClient.js';
import { loadConfig } from './config/config.js';
import type { LLMClient } from './llm/client.js';
import { runOrchestrator } from './orchestrator/qaAgent.js';
import { AgentLogger } from './orchestrator/logger.js';
import { loadTestCase } from './orchestrator/testCase.js';

type SubCommand = 'run' | 'qa';

interface RunArgs {
  subcommand: 'run';
  task: string;
  repo: string;
  llm: 'mock' | 'ollama';
  ollamaUrl?: string;
}

interface QaArgs {
  subcommand: 'qa';
  testcase: string;       // path to JSON test case file
  repo: string;
  llm: 'mock' | 'ollama';
  ollamaUrl?: string;
}

type Args = RunArgs | QaArgs;

function parseArgs(argv: string[]): Args {
  const sub = argv[0];
  if (sub !== 'run' && sub !== 'qa') {
    throw new Error(
      `usage: qa-agent <run|qa> [options]\n` +
        `  run --task <text> --repo <path> [--llm mock|ollama]\n` +
        `  qa  --testcase <path> --repo <path> [--llm mock|ollama]`,
    );
  }
  const rest = argv.slice(1);

  if (sub === 'run') {
    const args: Partial<RunArgs> = { subcommand: 'run', llm: 'mock' };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--task') args.task = rest[++i];
      else if (a === '--repo') args.repo = rest[++i];
      else if (a === '--llm') args.llm = rest[++i] as RunArgs['llm'];
      else if (a === '--ollama-url') args.ollamaUrl = rest[++i];
    }
    if (!args.task) throw new Error('run: --task is required');
    if (!args.repo) throw new Error('run: --repo is required');
    return args as RunArgs;
  }

  const args: Partial<QaArgs> = { subcommand: 'qa', llm: 'mock' };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--testcase') args.testcase = rest[++i];
    else if (a === '--repo') args.repo = rest[++i];
    else if (a === '--llm') args.llm = rest[++i] as QaArgs['llm'];
    else if (a === '--ollama-url') args.ollamaUrl = rest[++i];
  }
  if (!args.testcase) throw new Error('qa: --testcase is required');
  if (!args.repo) throw new Error('qa: --repo is required');
  return args as QaArgs;
}

function resolveOllamaUrl(explicit?: string): string {
  const url = explicit ?? process.env.OLLAMA_URL;
  if (!url) {
    throw new Error(
      '--llm ollama requires a URL. Pass --ollama-url <URL> or set OLLAMA_URL env var.\n' +
        'Example: --ollama-url https://your-host.runpod.net',
    );
  }
  return url;
}

function buildLLM(kind: RunArgs['llm'], ollamaUrl?: string): LLMClient {
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
    case 'ollama':
      return new OllamaClient({ url: resolveOllamaUrl(ollamaUrl) });
  }
}

function buildQaLLM(kind: QaArgs['llm'], ollamaUrl?: string): LLMClient {
  switch (kind) {
    case 'mock':
      return new MockLLMClient([]);
    case 'ollama':
      return new OllamaClient({ url: resolveOllamaUrl(ollamaUrl) });
  }
}

async function runGeneric(args: RunArgs): Promise<void> {
  const repoRoot = resolve(args.repo);
  const cfg = await loadConfig(repoRoot);

  const tools = new ToolRegistry();
  tools.register(fsReadTool);
  tools.register(
    createRunTestsTool({ command: cfg.validation.command, cwd: cfg.validation.cwd }),
  );
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

  const state = new ConversationLog(
    {
      id: runId,
      task: args.task,
      repoRoot,
      model: cfg.model,
      startedAt: new Date().toISOString(),
    },
    runDir,
  );

  const llm = buildLLM(args.llm, args.ollamaUrl);

  const result = await runAgent(
    args.task,
    {
      maxSteps: cfg.maxSteps,
      model: cfg.model,
      maxTokens: cfg.maxTokens,
      system:
        'You are a QA automation agent. Use the provided tools to inspect the repo. ' +
        'Prefer small, targeted reads. Stop as soon as the task is complete.',
    },
    { llm, tools, toolCtx: { repoRoot, runDir, paths: cfg.paths }, state },
  );

  await state.persist();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ runId, stopReason: result.stopReason, steps: result.steps, runDir }, null, 2));
}

async function runQa(args: QaArgs): Promise<void> {
  const repoRoot = resolve(args.repo);
  const cfg = await loadConfig(repoRoot);
  const testCase = await loadTestCase(resolve(args.testcase));

  const runId = newRunId();
  const runDir = resolve(repoRoot, '.qa-agent', 'runs', runId);
  await mkdir(runDir, { recursive: true });

  // ConversationLog is shared across all runAgent() invocations inside the orchestrator.
  // The orchestrator persists it after each phase.
  const runState = new ConversationLog(
    {
      id: runId,
      task: `qa: ${testCase.title}`,
      repoRoot,
      model: cfg.model,
      startedAt: new Date().toISOString(),
    },
    runDir,
  );

  const logger = new AgentLogger(runDir, runId);
  const llm = buildQaLLM(args.llm, args.ollamaUrl);

  const result = await runOrchestrator(
    testCase,
    {
      maxFixAttempts: cfg.maxFixAttempts,
      maxTokens: cfg.maxTokens,
      model: cfg.model,
      defaultSpecFile: 'tests/generic/agent-generated.spec.ts',
      locales: cfg.locales,
      validation: { command: cfg.validation.command, cwd: cfg.validation.cwd },
      browse: cfg.browse,
    },
    {
      llm,
      toolCtx: { repoRoot, runDir, paths: cfg.paths },
      conversationLog: runState,
      agentLogger: logger,
    },
  );

  console.log(
    JSON.stringify(
      {
        runId,
        finalPhase: result.finalPhase,
        fixAttemptsUsed: result.state.fixAttemptsUsed,
        ...(result.existingTestFile
          ? { skippedGenerate: true, existingTestFile: result.existingTestFile }
          : {}),
        runDir,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.subcommand === 'run') {
    await runGeneric(args);
  } else {
    await runQa(args);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
