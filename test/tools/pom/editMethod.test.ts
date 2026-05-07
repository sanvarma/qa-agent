import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeTempRepo, type TempRepo } from '../../helpers/tempRepo.js';
import { pomEditMethodTool } from '../../../src/tools/pom/editMethod.js';

describe('pom.editMethod — create (method does not exist)', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('creates a new async method with params', async () => {
    repo = await makeTempRepo();
    const pomPath = await repo.write(
      'src/pages/LoginPage.ts',
      [
        'export class LoginPage {',
        '  readonly emailInput = this.loc("input[type=\'email\']");',
        '}',
        '',
      ].join('\n'),
    );

    const out = await pomEditMethodTool.run(
      {
        file: 'src/pages/LoginPage.ts',
        name: 'login',
        params: 'username: string, password: string',
        isAsync: true,
        returnType: 'Promise<void>',
        newBody: 'await this.emailInput.fill(username);',
      },
      repo.toolCtx,
    );

    assert.equal(out.ok, true);
    const disk = await readFile(pomPath, 'utf8');
    assert.match(disk, /async login\(username: string, password: string\)/);
    assert.match(disk, /await this\.emailInput\.fill\(username\)/);
  });

  test('creates a new method with no params using defaults', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'src/pages/CartPage.ts',
      ['export class CartPage {', '}', ''].join('\n'),
    );

    const out = await pomEditMethodTool.run(
      { file: 'src/pages/CartPage.ts', name: 'proceedToCheckout', newBody: 'await this.checkoutButton.click();' },
      repo.toolCtx,
    );

    assert.equal(out.ok, true);
    const disk = await readFile(resolve(repo.repoRoot, 'src/pages/CartPage.ts'), 'utf8');
    assert.match(disk, /async proceedToCheckout\(\): Promise<void>/);
  });
});

describe('pom.editMethod — replace (method exists)', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('replaces method body and preserves signature', async () => {
    repo = await makeTempRepo();
    const pomPath = await repo.write(
      'src/pages/LoginPage.ts',
      [
        'export class LoginPage {',
        '  async login(email: string, password: string): Promise<void> {',
        '    // old impl',
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    const out = await pomEditMethodTool.run(
      {
        file: 'src/pages/LoginPage.ts',
        name: 'login',
        newBody: "console.log('new impl');",
      },
      repo.toolCtx,
    );

    assert.equal(out.ok, true);
    const disk = await readFile(pomPath, 'utf8');
    // Signature (params, return type, async) must be preserved.
    assert.match(disk, /async login\(email: string, password: string\): Promise<void>/);
    assert.match(disk, /console\.log\('new impl'\)/);
    assert.doesNotMatch(disk, /old impl/);
  });
});

describe('pom.editMethod — refusals', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('refuses to edit a getter (redirects to pom.updateSelector)', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'src/pages/P.ts',
      [
        'export class P {',
        '  get field() { return 1; }',
        '}',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        pomEditMethodTool.run(
          {
            file: 'src/pages/P.ts',
            name: 'field',
            newBody: 'return 2;',
          },
          repo.toolCtx,
        ),
      /getter.*pom\.updateSelector/,
    );
  });

  test('refuses to edit a constructor', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'src/pages/P.ts',
      [
        'export class P {',
        '  constructor() {}',
        '}',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        pomEditMethodTool.run(
          {
            file: 'src/pages/P.ts',
            name: 'constructor',
            newBody: '// x',
          },
          repo.toolCtx,
        ),
      /constructor/,
    );
  });

  test('refuses overloaded methods', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'src/pages/P.ts',
      [
        'export class P {',
        '  foo(x: string): void;',
        '  foo(x: number): void;',
        '  foo(x: string | number) { /* impl */ }',
        '}',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        pomEditMethodTool.run(
          {
            file: 'src/pages/P.ts',
            name: 'foo',
            newBody: '// x',
          },
          repo.toolCtx,
        ),
      /overloaded/,
    );
  });

  test('surfaces body_parse_failed on syntactically invalid newBody', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'src/pages/P.ts',
      [
        'export class P {',
        '  async doThing() {}',
        '}',
        '',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        pomEditMethodTool.run(
          {
            file: 'src/pages/P.ts',
            name: 'doThing',
            newBody: 'this is not valid typescript at all @@@ (((',
          },
          repo.toolCtx,
        ),
      /body_parse_failed/,
    );
  });
});
