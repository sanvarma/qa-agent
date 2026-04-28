import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeTempRepo } from '../../helpers/tempRepo.js';
import { testEditCaseTool } from '../../../src/tools/test/editCase.js';
describe('test.editCase — success', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('replaces body of a targeted test and returns a diff', async () => {
        repo = await makeTempRepo();
        const specPath = await repo.write('tests/login.spec.ts', [
            "import { test } from '@playwright/test';",
            '',
            "test('logs in', async ({ page }) => {",
            "  await page.goto('/old');",
            '});',
            '',
        ].join('\n'));
        const out = await testEditCaseTool.run({
            file: 'tests/login.spec.ts',
            title: 'logs in',
            newBody: "await page.goto('/new');",
        }, repo.toolCtx);
        assert.equal(out.file, 'tests/login.spec.ts');
        assert.match(out.diff, /-\s*await page\.goto\('\/old'\)/);
        assert.match(out.diff, /\+\s*await page\.goto\('\/new'\)/);
        // Verify disk was actually updated.
        const disk = await readFile(specPath, 'utf8');
        assert.match(disk, /\/new/);
        assert.doesNotMatch(disk, /\/old/);
    });
});
describe('test.editCase — refusals', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('refuses a path outside paths.tests', async () => {
        repo = await makeTempRepo();
        await repo.write('src/pages/LoginPage.ts', 'export class LoginPage {}\n');
        await assert.rejects(() => testEditCaseTool.run({
            file: 'src/pages/LoginPage.ts',
            title: 'x',
            newBody: '// x',
        }, repo.toolCtx), /scope violation.*tests/);
    });
    test('fails clearly when test not found', async () => {
        repo = await makeTempRepo();
        await repo.write('tests/login.spec.ts', "import { test } from '@playwright/test';\ntest('existing', async () => {});\n");
        await assert.rejects(() => testEditCaseTool.run({
            file: 'tests/login.spec.ts',
            title: 'does not exist',
            newBody: '// x',
        }, repo.toolCtx), /test not found/);
    });
    test('surfaces ambiguity error with describePath hint', async () => {
        repo = await makeTempRepo();
        await repo.write('tests/login.spec.ts', [
            "import { test } from '@playwright/test';",
            "test.describe('A', () => {",
            "  test('same', async () => {});",
            '});',
            "test.describe('B', () => {",
            "  test('same', async () => {});",
            '});',
            '',
        ].join('\n'));
        await assert.rejects(() => testEditCaseTool.run({
            file: 'tests/login.spec.ts',
            title: 'same',
            newBody: '// x',
        }, repo.toolCtx), /ambiguous|Pass describePath/);
    });
    test('refuses to edit test.each', async () => {
        repo = await makeTempRepo();
        await repo.write('tests/each.spec.ts', [
            "import { test } from '@playwright/test';",
            'test.each([1, 2])(\'item %i\', async (n) => {});',
            '',
        ].join('\n'));
        await assert.rejects(() => testEditCaseTool.run({
            file: 'tests/each.spec.ts',
            title: 'item %i',
            newBody: '// x',
        }, repo.toolCtx), /parameterized/);
    });
});
//# sourceMappingURL=editCase.test.js.map