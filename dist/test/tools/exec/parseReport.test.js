import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempRepo } from '../../helpers/tempRepo.js';
import { parseReportTool } from '../../../src/tools/exec/parseReport.js';
import { resolve } from 'node:path';
// Minimal Playwright-shaped JSON report. We only populate the fields
// parseReport actually reads (suites > specs > tests > results + stats).
function makeReport(overrides = {}) {
    const base = {
        stats: { expected: 0, unexpected: 0, skipped: 0, flaky: 0 },
        suites: [],
        ...overrides,
    };
    return JSON.stringify(base);
}
describe('exec.parseReport — valid report', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('reports zero failures on an empty report', async () => {
        repo = await makeTempRepo();
        const reportPath = await repo.write('.qa-agent/runs/test-run/report.json', makeReport());
        const out = await parseReportTool.run({ reportPath, maxFailures: 25 }, repo.toolCtx);
        assert.equal(out.totals.passed, 0);
        assert.equal(out.totals.failed, 0);
        assert.deepEqual(out.failures, []);
        assert.equal(out.truncated, false);
    });
    test('extracts a single failure from a populated report', async () => {
        repo = await makeTempRepo();
        const report = JSON.stringify({
            stats: { expected: 0, unexpected: 1, skipped: 0, flaky: 0 },
            suites: [
                {
                    title: 'Auth',
                    file: 'tests/auth.spec.ts',
                    specs: [
                        {
                            title: 'logs in',
                            file: 'tests/auth.spec.ts',
                            line: 5,
                            tests: [
                                {
                                    results: [
                                        {
                                            status: 'failed',
                                            error: { message: 'boom', stack: 'Error: boom\n  at ...' },
                                        },
                                    ],
                                },
                            ],
                        },
                    ],
                },
            ],
        });
        const reportPath = await repo.write('.qa-agent/runs/test-run/report.json', report);
        const out = await parseReportTool.run({ reportPath, maxFailures: 25 }, repo.toolCtx);
        assert.equal(out.totals.failed, 1);
        assert.equal(out.failures.length, 1);
        assert.equal(out.failures[0].testTitle, 'Auth > logs in');
        assert.equal(out.failures[0].file, 'tests/auth.spec.ts');
        assert.equal(out.failures[0].status, 'failed');
        assert.match(out.failures[0].message, /boom/);
    });
});
describe('exec.parseReport — error cases', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('throws clear error when report file is missing', async () => {
        repo = await makeTempRepo();
        const reportPath = resolve(repo.runDir, 'nope.json');
        await assert.rejects(() => parseReportTool.run({ reportPath, maxFailures: 25 }, repo.toolCtx), /report not found/);
    });
    test('throws when report is malformed JSON', async () => {
        repo = await makeTempRepo();
        const reportPath = await repo.write('.qa-agent/runs/test-run/bad.json', '{not valid json');
        await assert.rejects(() => parseReportTool.run({ reportPath, maxFailures: 25 }, repo.toolCtx), /not valid JSON/);
    });
    test('throws when reportPath is relative', async () => {
        repo = await makeTempRepo();
        await assert.rejects(() => parseReportTool.run({ reportPath: 'relative/path.json', maxFailures: 25 }, repo.toolCtx), /must be absolute/);
    });
});
describe('exec.parseReport — failure cap', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('truncates when failures exceed maxFailures', async () => {
        repo = await makeTempRepo();
        // Build a report with 5 failures; cap at 2.
        const specs = Array.from({ length: 5 }, (_, i) => ({
            title: `test-${i}`,
            file: 'tests/x.spec.ts',
            tests: [{ results: [{ status: 'failed', error: { message: `err-${i}` } }] }],
        }));
        const report = JSON.stringify({
            stats: { expected: 0, unexpected: 5, skipped: 0, flaky: 0 },
            suites: [{ title: 'S', file: 'tests/x.spec.ts', specs }],
        });
        const reportPath = await repo.write('.qa-agent/runs/test-run/report.json', report);
        const out = await parseReportTool.run({ reportPath, maxFailures: 2 }, repo.toolCtx);
        assert.equal(out.failures.length, 2);
        assert.equal(out.truncated, true);
        assert.equal(out.totals.failed, 5, 'totals reflect full report, not cap');
    });
});
//# sourceMappingURL=parseReport.test.js.map