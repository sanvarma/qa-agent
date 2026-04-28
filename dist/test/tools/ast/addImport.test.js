import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeTempRepo } from '../../helpers/tempRepo.js';
import { astAddImportTool } from '../../../src/tools/ast/addImport.js';
describe('ast.addImport — success', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('adds named import to a file under paths.tests', async () => {
        repo = await makeTempRepo();
        const path = await repo.write('tests/x.spec.ts', 'export const x = 1;\n');
        const out = await astAddImportTool.run({ file: 'tests/x.spec.ts', from: '@playwright/test', named: ['test'], typeOnly: false }, repo.toolCtx);
        assert.equal(out.changed, true);
        assert.deepEqual(out.added.named, ['test']);
        const disk = await readFile(path, 'utf8');
        assert.match(disk, /import \{ test \} from ['"`]@playwright\/test['"`]/);
    });
    test('adds named import to a file under paths.pages (dual-scope)', async () => {
        repo = await makeTempRepo();
        const path = await repo.write('src/pages/P.ts', 'export class P {}\n');
        const out = await astAddImportTool.run({ file: 'src/pages/P.ts', from: '@playwright/test', named: ['Page'], typeOnly: false }, repo.toolCtx);
        assert.equal(out.changed, true);
        const disk = await readFile(path, 'utf8');
        assert.match(disk, /import \{ Page \} from ['"`]@playwright\/test['"`]/);
    });
    test('idempotent no-op returns changed=false', async () => {
        repo = await makeTempRepo();
        const path = await repo.write('tests/x.spec.ts', "import { test } from '@playwright/test';\n");
        const before = await readFile(path, 'utf8');
        const out = await astAddImportTool.run({ file: 'tests/x.spec.ts', from: '@playwright/test', named: ['test'], typeOnly: false }, repo.toolCtx);
        assert.equal(out.changed, false);
        assert.equal(out.diff, '');
        const after = await readFile(path, 'utf8');
        assert.equal(after, before);
    });
});
describe('ast.addImport — refusals', () => {
    let repo;
    afterEach(async () => { if (repo)
        await repo.cleanup(); });
    test('refuses paths outside both paths.tests and paths.pages', async () => {
        repo = await makeTempRepo();
        await repo.write('lib/util.ts', 'export const x = 1;\n');
        await assert.rejects(() => astAddImportTool.run({ file: 'lib/util.ts', from: '@playwright/test', named: ['test'], typeOnly: false }, repo.toolCtx), /scope violation/);
    });
    test('errors on conflicting default import', async () => {
        repo = await makeTempRepo();
        await repo.write('tests/x.spec.ts', "import lodash from 'lodash';\n");
        await assert.rejects(() => astAddImportTool.run({ file: 'tests/x.spec.ts', from: 'lodash', default: '_', typeOnly: false }, repo.toolCtx), /conflicting_default/);
    });
});
//# sourceMappingURL=addImport.test.js.map