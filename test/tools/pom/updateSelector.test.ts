import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeTempRepo, type TempRepo } from '../../helpers/tempRepo.js';
import { pomUpdateSelectorTool } from '../../../src/tools/pom/updateSelector.js';

describe('pom.updateSelector — success', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('swaps the selector string and leaves other fields untouched', async () => {
    repo = await makeTempRepo();
    const pomPath = await repo.write(
      'src/pages/LoginPage.ts',
      [
        "import { Page } from '@playwright/test';",
        'export class LoginPage {',
        "  emailField = this.page.locator('[data-test=email]');",
        "  passwordField = this.page.locator('[data-test=password]');",
        '  constructor(private page: Page) {}',
        '}',
        '',
      ].join('\n'),
    );

    const out = await pomUpdateSelectorTool.run(
      {
        file: 'src/pages/LoginPage.ts',
        name: 'emailField',
        newSelector: '[data-testid=email]',
      },
      repo.toolCtx,
    );

    assert.equal(out.before, '[data-test=email]');
    assert.equal(out.after, '[data-testid=email]');
    assert.equal(out.className, 'LoginPage');

    const disk = await readFile(pomPath, 'utf8');
    // New selector present; old selector on emailField gone; password untouched.
    assert.match(disk, /\[data-testid=email\]/);
    assert.doesNotMatch(disk, /\[data-test=email\]/);
    assert.match(disk, /\[data-test=password\]/);
  });

  test('is idempotent when new selector equals current', async () => {
    repo = await makeTempRepo();
    const pomPath = await repo.write(
      'src/pages/LoginPage.ts',
      [
        'export class LoginPage {',
        "  emailField = this.page.locator('[data-test=email]');",
        '}',
        '',
      ].join('\n'),
    );
    const before = await readFile(pomPath, 'utf8');

    const out = await pomUpdateSelectorTool.run(
      {
        file: 'src/pages/LoginPage.ts',
        name: 'emailField',
        newSelector: '[data-test=email]',
      },
      repo.toolCtx,
    );

    assert.equal(out.diff, '', 'idempotent no-op returns empty diff');
    const after = await readFile(pomPath, 'utf8');
    assert.equal(after, before, 'file byte-identical after no-op');
  });
});

describe('pom.updateSelector — refusals', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('refuses paths outside paths.pages', async () => {
    repo = await makeTempRepo();
    await repo.write('tests/x.spec.ts', 'test("x", async () => {});\n');

    await assert.rejects(
      () =>
        pomUpdateSelectorTool.run(
          {
            file: 'tests/x.spec.ts',
            name: 'field',
            newSelector: '[x]',
          },
          repo.toolCtx,
        ),
      /scope violation.*pages/,
    );
  });

  test('refuses chained selectors with a clear message', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'src/pages/P.ts',
      [
        'export class P {',
        "  inner = this.page.locator('.card').locator('button');",
        '}',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        pomUpdateSelectorTool.run(
          {
            file: 'src/pages/P.ts',
            name: 'inner',
            newSelector: '[x]',
          },
          repo.toolCtx,
        ),
      /chained/,
    );
  });
});
