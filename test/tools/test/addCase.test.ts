import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeTempRepo, type TempRepo } from '../../helpers/tempRepo.js';
import { testAddCaseTool } from '../../../src/tools/test/addCase.js';

describe('test.addCase — success', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('appends a test to an existing spec at top level', async () => {
    repo = await makeTempRepo();
    const specPath = await repo.write(
      'tests/login.spec.ts',
      "import { test } from '@playwright/test';\n",
    );

    const out = await testAddCaseTool.run(
      {
        file: 'tests/login.spec.ts',
        title: 'new test',
        body: "await page.goto('/');",
        position: 'end',
      },
      repo.toolCtx,
    );

    assert.equal(out.file, 'tests/login.spec.ts');
    assert.equal(out.symbolPath, 'new test');
    assert.ok(out.insertedAt.startLine > 0);

    const disk = await readFile(specPath, 'utf8');
    assert.match(disk, /test\('new test'/);
  });

  test('appends a test inside a named describe', async () => {
    repo = await makeTempRepo();
    const specPath = await repo.write(
      'tests/login.spec.ts',
      [
        "import { test } from '@playwright/test';",
        "test.describe('Auth', () => {",
        '});',
        '',
      ].join('\n'),
    );

    const out = await testAddCaseTool.run(
      {
        file: 'tests/login.spec.ts',
        title: 'logs in',
        describe: 'Auth',
        body: '// steps',
        position: 'end',
      },
      repo.toolCtx,
    );

    assert.equal(out.symbolPath, 'Auth > logs in');
    const disk = await readFile(specPath, 'utf8');
    assert.match(disk, /test\.describe\('Auth'[\s\S]*test\('logs in'/);
  });
});

describe('test.addCase — testData field validation', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('rejects body that accesses a non-existent field', async () => {
    repo = await makeTempRepo();
    await repo.write('src/data/testdata.json', JSON.stringify({
      users: [{ username: 'alice', password: 'secret' }],
    }));
    await repo.write('tests/login.spec.ts', "import { test } from '@playwright/test';\n");

    await assert.rejects(
      () => testAddCaseTool.run(
        {
          file: 'tests/login.spec.ts',
          title: 'bad field test',
          body: "const user = testData('users');\nawait page.fill('#u', user.email);",
          position: 'end',
        },
        repo.toolCtx,
      ),
      /testData field mismatch.*'email'.*Valid fields.*'username'.*'password'/,
    );
  });

  test('accepts body that only accesses valid fields', async () => {
    repo = await makeTempRepo();
    await repo.write('src/data/testdata.json', JSON.stringify({
      users: [{ username: 'alice', password: 'secret' }],
    }));
    await repo.write('tests/login.spec.ts', "import { test } from '@playwright/test';\n");

    const out = await testAddCaseTool.run(
      {
        file: 'tests/login.spec.ts',
        title: 'good field test',
        body: "const user = testData('users');\nawait page.fill('#u', user.username);",
        position: 'end',
      },
      repo.toolCtx,
    );
    assert.ok(out.insertedAt.startLine > 0);
  });

  test('ignores unknown dataset key (no schema to check against)', async () => {
    repo = await makeTempRepo();
    await repo.write('tests/login.spec.ts', "import { test } from '@playwright/test';\n");

    const out = await testAddCaseTool.run(
      {
        file: 'tests/login.spec.ts',
        title: 'unknown key test',
        body: "const x = testData('nonexistent');\nawait page.fill('#u', x.whatever);",
        position: 'end',
      },
      repo.toolCtx,
    );
    assert.ok(out.insertedAt.startLine > 0);
  });
});

describe('test.addCase — refusals', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('refuses when the spec file does not exist', async () => {
    repo = await makeTempRepo();
    await assert.rejects(
      () =>
        testAddCaseTool.run(
          {
            file: 'tests/missing.spec.ts',
            title: 'x',
            body: '// x',
            position: 'end',
          },
          repo.toolCtx,
        ),
      /not found.*test\.createSpec/,
    );
  });

  test('refuses on duplicate title in same scope', async () => {
    repo = await makeTempRepo();
    await repo.write(
      'tests/login.spec.ts',
      [
        "import { test } from '@playwright/test';",
        "test('dupe', async () => {});",
        '',
      ].join('\n'),
    );

    await assert.rejects(
      () =>
        testAddCaseTool.run(
          {
            file: 'tests/login.spec.ts',
            title: 'dupe',
            body: '// x',
            position: 'end',
          },
          repo.toolCtx,
        ),
      /duplicate_title/,
    );
  });
});
