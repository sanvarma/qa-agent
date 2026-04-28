import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, sep } from 'node:path';
import { resolveWithinScope } from '../../../src/tools/util/scope.js';
// Synthetic repo — we don't care whether it exists on disk. scope.ts only
// does path arithmetic; it doesn't touch the filesystem.
const repoRoot = resolve('/tmp', 'fake-repo');
const ctx = {
    repoRoot,
    paths: { pages: 'src/pages', tests: 'tests' },
};
describe('resolveWithinScope — happy path', () => {
    test('resolves a valid tests path to absolute', () => {
        const abs = resolveWithinScope('tests/login.spec.ts', 'tests', ctx);
        assert.equal(abs, resolve(repoRoot, 'tests/login.spec.ts'));
    });
    test('resolves a valid pages path to absolute', () => {
        const abs = resolveWithinScope('src/pages/LoginPage.ts', 'pages', ctx);
        assert.equal(abs, resolve(repoRoot, 'src/pages/LoginPage.ts'));
    });
});
describe('resolveWithinScope — refusals', () => {
    test('refuses absolute input path', () => {
        assert.throws(() => resolveWithinScope(resolve('/etc/passwd'), 'tests', ctx), /path must be relative/);
    });
    test('refuses path that escapes repo root with ..', () => {
        assert.throws(() => resolveWithinScope(`..${sep}outside.ts`, 'tests', ctx), /escapes repo root/);
    });
    test('refuses tests path when scope is pages', () => {
        assert.throws(() => resolveWithinScope('tests/login.spec.ts', 'pages', ctx), /scope violation.*pages/);
    });
    test('throws when ToolContext.paths is missing', () => {
        const noPathCtx = { repoRoot };
        assert.throws(() => resolveWithinScope('tests/x.ts', 'tests', noPathCtx), /paths is required/);
    });
});
//# sourceMappingURL=scope.test.js.map