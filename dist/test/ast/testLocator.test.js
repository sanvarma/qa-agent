import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { findTestCase } from '../../src/ast/testLocator.js';
import { makeSourceFile } from '../helpers/inMemoryProject.js';
describe('findTestCase — happy path', () => {
    test('finds a top-level test by title', () => {
        const sf = makeSourceFile(`
      import { test, expect } from '@playwright/test';
      test('loads home', async ({ page }) => { await page.goto('/'); });
    `);
        const r = findTestCase(sf, { title: 'loads home', fileLabel: 'home.spec.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.title, 'loads home');
        assert.equal(r.locator.describePath.length, 0);
        assert.equal(r.locator.kind, 'test');
        assert.equal(r.locator.isEach, false);
    });
    test('finds a test inside a describe', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.describe('Auth', () => {
        test('logs in', async ({ page }) => {});
      });
    `);
        const r = findTestCase(sf, { title: 'logs in', fileLabel: 'auth.spec.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.deepEqual(r.locator.describePath, ['Auth']);
    });
    test('finds a test inside nested describes via exact describePath', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.describe('Auth', () => {
        test.describe('Login', () => {
          test('valid creds', async ({ page }) => {});
        });
      });
    `);
        const r = findTestCase(sf, {
            title: 'valid creds',
            describePath: ['Auth', 'Login'],
            fileLabel: 'auth.spec.js',
        });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.deepEqual(r.locator.describePath, ['Auth', 'Login']);
    });
    test('recognizes `it(...)` as a test', () => {
        const sf = makeSourceFile(`
      it('does a thing', async () => {});
    `);
        const r = findTestCase(sf, { title: 'does a thing', fileLabel: 'f.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.kind, 'it');
    });
});
describe('findTestCase — modifiers', () => {
    test('recognizes test.only and preserves modifier', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.only('focused', async () => {});
    `);
        const r = findTestCase(sf, { title: 'focused', fileLabel: 'f.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.modifier, 'only');
    });
    test('recognizes test.skip', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.skip('skipped', async () => {});
    `);
        const r = findTestCase(sf, { title: 'skipped', fileLabel: 'f.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.modifier, 'skip');
    });
    test('recognizes test.fixme', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.fixme('broken', async () => {});
    `);
        const r = findTestCase(sf, { title: 'broken', fileLabel: 'f.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.modifier, 'fixme');
    });
});
describe('findTestCase — test.each', () => {
    test('flags parameterized test so editor can refuse', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.each([1, 2])('param %i', async (n) => {});
    `);
        const r = findTestCase(sf, { title: 'param %i', fileLabel: 'f.js' });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.equal(r.locator.isEach, true, 'test.each must set isEach=true');
    });
});
describe('findTestCase — ambiguity and misses', () => {
    test('two tests with same title in different describes are ambiguous without describePath', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.describe('A', () => {
        test('same', async () => {});
      });
      test.describe('B', () => {
        test('same', async () => {});
      });
    `);
        const r = findTestCase(sf, { title: 'same', fileLabel: 'f.js' });
        assert.equal(r.status, 'ambiguous');
        if (r.status !== 'ambiguous')
            return;
        assert.equal(r.candidates.length, 2);
    });
    test('same title with describePath disambiguates', () => {
        const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test.describe('A', () => {
        test('same', async () => {});
      });
      test.describe('B', () => {
        test('same', async () => {});
      });
    `);
        const r = findTestCase(sf, {
            title: 'same',
            describePath: ['B'],
            fileLabel: 'f.js',
        });
        assert.equal(r.status, 'found');
        if (r.status !== 'found')
            return;
        assert.deepEqual(r.locator.describePath, ['B']);
    });
    test('not-found returns candidates from the file', () => {
        const sf = makeSourceFile(`
      test('existing one', async () => {});
      test('another', async () => {});
    `);
        const r = findTestCase(sf, { title: 'does not exist', fileLabel: 'f.js' });
        assert.equal(r.status, 'not_found');
        if (r.status !== 'not_found')
            return;
        assert.equal(r.candidates.length, 2);
        assert.ok(r.candidates.some((c) => c.title === 'existing one'));
    });
    test('non-literal title (template with interpolation) is invisible to locator', () => {
        // Deliberate: we can't match user-supplied strings against interpolated titles.
        const sf = makeSourceFile(`
      const name = 'x';
      test(\`dynamic \${name}\`, async () => {});
    `);
        const r = findTestCase(sf, { title: 'dynamic x', fileLabel: 'f.js' });
        assert.equal(r.status, 'not_found');
    });
});
//# sourceMappingURL=testLocator.test.js.map