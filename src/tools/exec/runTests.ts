import { z } from 'zod';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Tool } from '../tool.js';

// Keep stdout/stderr tails bounded so a chatty test run doesn't blow up context.
const TAIL_BYTES = 8 * 1024;

const Input = z.object({
  // Optional grep pattern to narrow the run (maps to Playwright's --grep).
  grep: z.string().optional(),
  // Extra args appended verbatim after the base command.
  extraArgs: z.array(z.string()).optional(),
  // Overrides the config's validation.cwd. Relative to repoRoot; defaults to repoRoot.
  cwd: z.string().optional(),
  // Overrides the config's validation.command entirely. Use sparingly.
  command: z.string().optional(),
  // Hard timeout for the whole run. Default 10 minutes.
  timeoutMs: z.number().int().positive().max(60 * 60 * 1000).optional(),
});
type Input = z.infer<typeof Input>;

interface Output {
  // Convenience: true iff the run completed and exit code was zero.
  // Equivalent to (exitCode === 0 && !timedOut). Kept as a separate field so
  // callers don't have to recompute it and so the LLM has a first-class signal.
  success: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  command: string;
  cwd: string;
  reportPath: string;    // absolute path to raw Playwright JSON report
  stdoutTail: string;    // last TAIL_BYTES of stdout
  stderrTail: string;    // last TAIL_BYTES of stderr
}

// Dependency-injectable config surface. The tool reads from process env at
// construction time via a thin factory so we don't couple tools to the Config loader.
export interface RunTestsDefaults {
  command: string;
  cwd?: string;
}

export function createRunTestsTool(defaults: RunTestsDefaults): Tool<Input, Output> {
  return {
    name: 'exec.runTests',
    description:
      'Run the configured Playwright test command and capture the JSON report. ' +
      'Returns a pointer to the report plus exit code and output tails. ' +
      'Does not parse failures — call exec.parseReport on the returned reportPath.',
    inputSchema: Input,
    jsonSchema: {
      type: 'object',
      properties: {
        grep: { type: 'string', description: 'Narrow to tests matching this pattern' },
        extraArgs: { type: 'array', items: { type: 'string' } },
        cwd: { type: 'string', description: 'Relative to repo root' },
        command: { type: 'string', description: 'Override full command (advanced)' },
        timeoutMs: { type: 'integer', minimum: 1 },
      },
      additionalProperties: false,
    },

    async run(input, ctx) {
      if (!ctx.runDir) {
        throw new Error('exec.runTests requires ToolContext.runDir');
      }

      const baseCommand = input.command ?? defaults.command;
      const parts: string[] = [baseCommand];
      if (input.grep) {
        // Shell-escape the grep value. Simple single-quote wrap; reject embedded single quotes.
        if (input.grep.includes("'")) throw new Error("grep must not contain single quotes");
        parts.push(`--grep '${input.grep}'`);
      }
      if (input.extraArgs && input.extraArgs.length > 0) {
        for (const a of input.extraArgs) {
          if (a.includes("'")) throw new Error('extraArgs must not contain single quotes');
          parts.push(`'${a}'`);
        }
      }
      const fullCommand = parts.join(' ');

      const cwdRel = input.cwd ?? defaults.cwd;
      const cwdAbs = cwdRel ? resolve(ctx.repoRoot, cwdRel) : ctx.repoRoot;

      const artifactsDir = join(ctx.runDir, 'artifacts');
      await mkdir(artifactsDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const reportPath = join(artifactsDir, `playwright-report-${stamp}.json`);

      const started = Date.now();
      const timeoutMs = input.timeoutMs ?? 10 * 60 * 1000;

      // Playwright's JSON reporter writes to PLAYWRIGHT_JSON_OUTPUT_NAME when set.
      // This avoids needing the user to configure an output path in their Playwright config.
      const env = {
        ...process.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath,
      };

      const child = spawn(fullCommand, {
        cwd: cwdAbs,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      const MAX_BUFFER = 2 * 1024 * 1024; // safety cap on in-memory capture

      child.stdout.on('data', (c: Buffer) => {
        if (stdoutBytes < MAX_BUFFER) {
          stdoutChunks.push(c);
          stdoutBytes += c.length;
        }
      });
      child.stderr.on('data', (c: Buffer) => {
        if (stderrBytes < MAX_BUFFER) {
          stderrChunks.push(c);
          stderrBytes += c.length;
        }
      });

      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
        // Escalate if it doesn't exit promptly.
        setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
      }, timeoutMs);
      timer.unref();

      const exitCode: number | null = await new Promise((resolvePromise) => {
        child.on('close', (code) => resolvePromise(code));
      });
      clearTimeout(timer);

      const stdoutAll = Buffer.concat(stdoutChunks).toString('utf8');
      const stderrAll = Buffer.concat(stderrChunks).toString('utf8');

      return {
        success: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        command: fullCommand,
        cwd: cwdAbs,
        reportPath,
        stdoutTail: stdoutAll.slice(-TAIL_BYTES),
        stderrTail: stderrAll.slice(-TAIL_BYTES),
      };
    },
  };
}
