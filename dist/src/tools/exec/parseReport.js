import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
const Input = z.object({
    // Absolute path returned by exec.runTests.reportPath.
    reportPath: z.string().min(1),
    // Cap on failures returned, to bound context size. Remaining are summarized as count.
    maxFailures: z.number().int().min(1).max(200).default(25),
});
function truncate(s, n) {
    return s.length <= n ? s : s.slice(0, n);
}
function walkSpecs(suite, titlePrefix, out, limit) {
    const nextPrefix = suite.title ? [...titlePrefix, suite.title] : titlePrefix;
    for (const spec of suite.specs ?? []) {
        for (const test of spec.tests ?? []) {
            for (const result of test.results ?? []) {
                const status = result.status;
                if (status === 'failed' || status === 'timedOut' || status === 'interrupted') {
                    const err = result.error ?? result.errors?.[0];
                    const message = (err?.message ?? '').trim();
                    const stack = err?.stack ?? '';
                    out.push({
                        testTitle: [...nextPrefix, spec.title ?? ''].filter(Boolean).join(' > '),
                        file: spec.file ?? suite.file ?? '',
                        line: spec.line,
                        column: spec.column,
                        status: status,
                        message: truncate(message, 1024),
                        rawSnippet: truncate(stack || message, 2048),
                    });
                    if (out.length >= limit)
                        return true; // hit cap
                }
            }
        }
    }
    for (const child of suite.suites ?? []) {
        if (walkSpecs(child, nextPrefix, out, limit))
            return true;
    }
    return false;
}
export const parseReportTool = {
    name: 'exec.parseReport',
    description: 'Parse a Playwright JSON report into normalized totals and a bounded failure list. ' +
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
        let raw;
        try {
            raw = await readFile(input.reportPath, 'utf8');
        }
        catch (err) {
            const code = err.code;
            if (code === 'ENOENT') {
                throw new Error(`report not found at ${input.reportPath} — did the test run actually start?`);
            }
            throw err;
        }
        let report;
        try {
            report = JSON.parse(raw);
        }
        catch {
            throw new Error('report file is not valid JSON — check that --reporter=json is active');
        }
        const failures = [];
        const capped = (report.suites ?? []).some((s) => walkSpecs(s, [], failures, input.maxFailures));
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
//# sourceMappingURL=parseReport.js.map