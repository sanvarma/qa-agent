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

  test('position "start" inserts at the beginning of the auto-created describe block', () => {
    // Design contract: insertTestCase ALWAYS wraps inserted tests inside a describe
    // block (resolveScope, line 178 in testInserter.ts). When the file has no
    // existing describe, one is auto-created at the end of the file and the test
    // is inserted into it. So `position: 'start'` controls position within the
    // describe block, not the file. Pre-existing top-level tests stay where they are.
    const sf = makeSourceFile(`
      import { test } from '@playwright/test';
      test('existing', async () => {});
    `);
    const r = insertTestCase(sf, {
      title: 'first',
      body: '// noop',
      position: 'start',
    });

    const text = sf.getFullText();
    // Both tests exist
    assert.match(text, /test\('first'/, "new test should be present");
    assert.match(text, /test\('existing'/, "existing test should still be present");
    // A new describe was auto-created (filename-derived name)
    assert.match(text, /test\.describe\(/, "an enclosing describe block should have been created");
    assert.ok(r.startLine > 0);

    // Within the auto-created describe block, the new test is at position 'start' —
    // i.e. it's the first (and only) statement of the new describe.
    // The describe is appended after the pre-existing top-level test, so by file
    // order: existing top-level test → new describe block → new test inside it.
    const existingIdx = text.indexOf("test('existing'");
    const describeIdx = text.indexOf("test.describe(");
    const firstIdx = text.indexOf("test('first'");
    assert.ok(existingIdx < describeIdx, "auto-created describe goes after pre-existing top-level test");
    assert.ok(describeIdx < firstIdx, "new test is inside the auto-created describe (after its opening)");
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
    assert.throws(
      () =>
        insertTestCase(sf, {
          title: 'dupe',
          body: '// x',
          position: 'end',
        }),
      (err) => err instanceof InsertError && err.code === 'duplicate_title',
    );
  });

  test('rejects duplicate title even in a different describe (file-wide uniqueness)', () => {
    // Design contract: insertTestCase enforces FILE-WIDE title uniqueness, not
    // per-describe (testInserter.ts line 295–302). The rationale: Playwright's
    // `--grep <title>` matches across the whole file and cannot disambiguate
    // duplicates even if they live in different describes.
    // collectDirectTestTitles exists (per-scope) but is intentionally unused;
    // collectAllTestTitles (file-wide) is the active check.
    const sf = makeSourceFile(`
      test.describe('A', () => {
        test('shared', async () => {});
      });
      test.describe('B', () => {});
    `);
    assert.throws(
      () =>
        insertTestCase(sf, {
          title: 'shared',
          describe: 'B',
          body: '// x',
          position: 'end',
        }),
      (err) => err instanceof InsertError && err.code === 'duplicate_title',
    );
  });

  test('auto-creates the target describe when it does not exist', () => {
    // Design contract: a missing describe is auto-created rather than rejected
    // (testInserter.ts resolveScope, line 181–183). Lenient behavior — the
    // agent can request a logical describe name without first checking whether
    // it exists. The 'describe_not_found' error code is defined in InsertErrorCode
    // but is intentionally never thrown.
    const sf = makeSourceFile(`
      test.describe('Auth', () => {});
    `);
    const r = insertTestCase(sf, {
      title: 't',
      describe: 'NonExistent',
      body: '// x',
      position: 'end',
    });

    const text = sf.getFullText();
    // The originally-requested describe was created
    assert.match(text, /test\.describe\('NonExistent'/, "missing describe should be auto-created");
    // The test was inserted into it
    assert.match(text, /test\('t'/, "new test should be present");
    // Pre-existing describe is unaffected
    assert.match(text, /test\.describe\('Auth'/, "existing Auth describe should be preserved");
    assert.ok(r.startLine > 0);
  });

  test('throws describe_ambiguous when two top-level describes share a title', () => {
    const sf = makeSourceFile(`
      test.describe('Same', () => {});
      test.describe('Same', () => {});
    `);
    assert.throws(
      () =>
        insertTestCase(sf, {
          title: 't',
          describe: 'Same',
          body: '// x',
          position: 'end',
        }),
      (err) => err instanceof InsertError && err.code === 'describe_ambiguous',
    );
  });
});
