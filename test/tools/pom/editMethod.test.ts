import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeTempRepo, type TempRepo } from '../../helpers/tempRepo.js';
import { pomEditMethodTool } from '../../../src/tools/pom/editMethod.js';

describe('pom.editMethod — success', () => {
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

    assert.equal(out.symbolPath, 'LoginPage.login');
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
