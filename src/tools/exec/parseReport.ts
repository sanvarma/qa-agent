import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Tool } from '../tool.js';

const Input = z.object({
  // Absolute path returned by exec.runTests.reportPath.
  reportPath: z.string().min(1),
  // Cap on failures returned, to bound context size. Remaining are summarized as count.
  maxFailures: z.number().int().min(1).max(200).default(25),
});
type Input = z.infer<typeof Input>;

export interface NormalizedFailure {
  testTitle: string;   // full title path: "describe > it"
  file: string;        // spec file, relative if Playwright reported it that way
  line?: number;
  column?: number;
  status: 'failed' | 'timedOut' | 'interrupted';
  // Primary error message, trimmed. Full stack available in rawSnippet.
  message: string;
  // First ~2KB of the raw error for downstream classification.
  rawSnippet: string;
}

interface Output {
  totals: { passed: number; failed: number; skipped: number; flaky: number };
  failures: NormalizedFailure[];
  truncated: boolean;       // true if failures were capped
  reportPath: string;
}

// Minimal shape we read from Playwright's JSON reporter. We only touch fields
// we depend on — Playwright's schema is large and versions drift.
interface PwTestResult {
  status?: string;
  error?: { message?: string; stack?: string };
  errors?: Array<{ message?: string; stack?: string }>;
}
interface PwTest {
  results?: PwTestResult[];
}
interface PwSpec {
  title?: string;
  file?: string;
  line?: number;
  column?: number;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  file?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  stats?: {
    expected?: number;
    unexpected?: number;
    skipped?: number;
    flaky?: number;
  };
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

function walkSpecs(
  suite: PwSuite,
  titlePrefix: string[],
  out: NormalizedFailure[],
  limit: number,
): boolean {
  const nextPrefix = suite.title ? [...titlePrefix, suite.title] : titlePrefix;

  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      for (const result of test.results ?? []) {
        const status = result.status;
        if (status === 'failed' || status === 'timedOut' || status === 'interrupted') {
          // For timedOut tests, result.error is just "Test timeout exceeded" with no locator detail.
          // result.errors (plural) often contains a second entry with the full locator call log.
          // Prefer the most informative error — one that mentions a locator or selector.
          const allErrors = [...(result.errors ?? []), result.error].filter(Boolean);
          const err = allErrors.find(
            (e) => /locator|waiting for|selector/i.test(e?.message ?? ''),
          ) ?? result.error ?? result.errors?.[0];
          const message = (err?.message ?? '').trim();
          const stack = err?.stack ?? '';
          out.push({
            testTitle: [...nextPrefix, spec.title ?? ''].filter(Boolean).join(' > '),
            file: spec.file ?? suite.file ?? '',
            line: spec.line,
            column: spec.column,
            status: status as NormalizedFailure['status'],
            message: truncate(message, 1024),
            rawSnippet: truncate(stack || message, 2048),
          });
          if (out.length >= limit) return true; // hit cap
        }
      }
    }
  }

  for (const child of suite.suites ?? []) {
    if (walkSpecs(child, nextPrefix, out, limit)) return true;
  }
  return false;
}

export const parseReportTool: Tool<Input, Output> = {
  name: 'exec.parseReport',
  description:
    'Parse a Playwright JSON report into normalized totals and a bounded failure list. ' +
    'Use after exec.runTests. Does not classify failures.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      reportPath: { type: 'string' },
      maxFailures: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
    },
    required: ['reportPath'],
    additionalProperties: false,
  },

  async run(input, _ctx) {
    if (!isAbsolute(input.reportPath)) {
      throw new Error('reportPath must be absolute (use the value returned by exec.runTests)');
    }
    let raw: string;
    try {
      raw = await readFile(input.reportPath, 'utf8');
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(`report not found at ${input.reportPath} — did the test run actually start?`);
      }
      throw err;
    }

    let report: PwReport;
    try {
      report = JSON.parse(raw) as PwReport;
    } catch {
      throw new Error('report file is not valid JSON — check that --reporter=json is active');
    }

    const failures: NormalizedFailure[] = [];
    const capped = (report.suites ?? []).some((s) =>
      walkSpecs(s, [], failures, input.maxFailures),
    );

    const stats = report.stats ?? {};
    return {
      totals: {
        passed: stats.expected ?? 0,
        failed: stats.unexpected ?? failures.length,
        skipped: stats.skipped ?? 0,
        flaky: stats.flaky ?? 0,
      },
      failures,
      truncated: capped,
      reportPath: input.reportPath,
    };
  },
};
