import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { insertTestCase, InsertError } from '../../src/ast/testInserter.js';
import { makeSourceFile } from '../helpers/inMemoryProject.js';
describe('insertTestCase — top level', () => {
    test('appends a test at top level when no describe given', () => {
        const sf = makeSourceFile(`import { test } from '@playwright/test';\n`);
        const r = insertTestCase(sf, {
            title: 'new test',
            body: "await page.goto('/');",
            position: 'end',
        });
        assert.ok(r.startLine > 0);
        assert.ok(r.endLine >= r.startLine);
        const text = sf.getFullText();
        assert.match(text, /test\('new test'/);
        assert.match(text, /await page\.goto\('\/'\)/);
    });
    test('position "start" inserts before existing statements', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test('existing', async () => {});
    `);
        const r = insertTestCase(sf, {
            title: 'first',
            body: '// noop',
            position: 'start',
        });
        // New test must come before the existing one.
        const text = sf.getFullText();
        const firstIdx = text.indexOf("test('first'");
        const existingIdx = text.indexOf("test('existing'");
        assert.ok(firstIdx !== -1 && existingIdx !== -1);
        assert.ok(firstIdx < existingIdx, 'start-position insert should precede existing test');
        assert.ok(r.startLine > 0);
    });
});
describe('insertTestCase — inside describe', () => {
    test('inserts inside a named top-level describe', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.describe('Auth', () => {
        test('login', async () => {});
      });
    `);
        insertTestCase(sf, {
            title: 'logout',
            describe: 'Auth',
            body: '// logout steps',
            position: 'end',
        });
        const text = sf.getFullText();
        assert.match(text, /test\('logout'/);
        // The new test should be inside the Auth describe, i.e. before the closing `}`
        // of that describe. Verify by ordering: 'login' < 'logout' < end-of-describe.
        const loginIdx = text.indexOf("test('login'");
        const logoutIdx = text.indexOf("test('logout'");
        assert.ok(loginIdx < logoutIdx, 'logout must come after login inside describe');
    });
});
describe('insertTestCase — refusals', () => {
    test('throws duplicate_title when title already exists in scope', () => {
        const sf = makeSourceFile(`
      test('dupe', async () => {});
    `);
        assert.throws(() => insertTestCase(sf, {
            title: 'dupe',
            body: '// x',
            position: 'end',
        }), (err) => err instanceof InsertError && err.code === 'duplicate_title');
    });
    test('same title is allowed in different describes', () => {
        const sf = makeSourceFile(`
      test.describe('A', () => {
        test('shared', async () => {});
      });
      test.describe('B', () => {});
    `);
        // Inserting 'shared' into B must succeed — different scope.
        const r = insertTestCase(sf, {
            title: 'shared',
            describe: 'B',
            body: '// x',
            position: 'end',
        });
        assert.ok(r.startLine > 0);
    });
    test('throws describe_not_found when target describe does not exist', () => {
        const sf = makeSourceFile(`
      test.describe('Auth', () => {});
    `);
        assert.throws(() => insertTestCase(sf, {
            title: 't',
            describe: 'NonExistent',
            body: '// x',
            position: 'end',
        }), (err) => err instanceof InsertError && err.code === 'describe_not_found');
    });
    test('throws describe_ambiguous when two top-level describes share a title', () => {
        const sf = makeSourceFile(`
      test.describe('Same', () => {});
      test.describe('Same', () => {});
    `);
        assert.throws(() => insertTestCase(sf, {
            title: 't',
            describe: 'Same',
            body: '// x',
            position: 'end',
        }), (err) => err instanceof InsertError && err.code === 'describe_ambiguous');
    });
});
//# sourceMappingURL=testInserter.test.js.map