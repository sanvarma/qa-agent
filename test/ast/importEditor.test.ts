import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { addImport, ImportError } from '../../src/ast/importEditor.js';
import { makeSourceFile } from '../helpers/inMemoryProject.js';

describe('addImport — new declaration', () => {
  test('adds named imports to a file with no existing imports', () => {
    const sf = makeSourceFile(`export const x = 1;\n`);
    const r = addImport(sf, { moduleSpecifier: '@playwright/test', named: ['test', 'expect'] });
    assert.equal(r.changed, true);
    assert.deepEqual(r.added.named.sort(), ['expect', 'test']);
    assert.match(sf.getFullText(), /from ['"`]@playwright\/test['"`]/);
    assert.match(sf.getFullText(), /test/);
    assert.match(sf.getFullText(), /expect/);
  });

  test('adds default import', () => {
    const sf = makeSourceFile(`export const x = 1;\n`);
    const r = addImport(sf, { moduleSpecifier: 'lodash', defaultName: '_' });
    assert.equal(r.changed, true);
    assert.equal(r.added.default, '_');
    assert.match(sf.getFullText(), /import _ from ['"`]lodash['"`]/);
  });
});

describe('addImport — merge into existing', () => {
  test('adds a missing name to an existing import, leaves existing names intact', () => {
    const sf = makeSourceFile(`import { test } from '@playwright/test';\n`);
    const r = addImport(sf, { moduleSpecifier: '@playwright/test', named: ['expect'] });
    assert.equal(r.changed, true);
    assert.deepEqual(r.added.named, ['expect']);
    assert.match(sf.getFullText(), /\{ expect, test \}/);
  });

  test('is idempotent when all names already present', () => {
    const sf = makeSourceFile(`import { test, expect } from '@playwright/test';\n`);
    const r = addImport(sf, { moduleSpecifier: '@playwright/test', named: ['test', 'expect'] });
    assert.equal(r.changed, false);
    assert.deepEqual(r.added.named, []);
  });

  test('adding the same default twice is a no-op', () => {
    const sf = makeSourceFile(`import _ from 'lodash';\n`);
    const r = addImport(sf, { moduleSpecifier: 'lodash', defaultName: '_' });
    assert.equal(r.changed, false);
  });
});

describe('addImport — conflicts and edge cases', () => {
  test('conflicting default throws ImportError', () => {
    const sf = makeSourceFile(`import lodash from 'lodash';\n`);
    assert.throws(
      () => addImport(sf, { moduleSpecifier: 'lodash', defaultName: '_' }),
      (err) => err instanceof ImportError && err.code === 'conflicting_default',
    );
  });

  test('empty request throws nothing_to_add', () => {
    const sf = makeSourceFile(``);
    assert.throws(
      () => addImport(sf, { moduleSpecifier: '@playwright/test' }),
      (err) => err instanceof ImportError && err.code === 'nothing_to_add',
    );
  });

  test('typeOnly import coexists separately from value import of same module', () => {
    const sf = makeSourceFile(`import { Page } from '@playwright/test';\n`);
    const r = addImport(sf, {
      moduleSpecifier: '@playwright/test',
      named: ['Locator'],
      typeOnly: true,
    });
    assert.equal(r.changed, true);
    const text = sf.getFullText();
    // Two separate declarations — one value, one type-only.
    assert.match(text, /import \{ Page \} from ['"`]@playwright\/test['"`]/);
    assert.match(text, /import type \{ Locator \} from ['"`]@playwright\/test['"`]/);
  });
});
