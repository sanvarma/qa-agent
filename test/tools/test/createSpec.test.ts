import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { makeTempRepo, type TempRepo } from '../../helpers/tempRepo.js';
import { testCreateSpecTool } from '../../../src/tools/test/createSpec.js';

describe('test.createSpec — success', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('creates a minimal spec file with the Playwright import', async () => {
    repo = await makeTempRepo();
    const out = await testCreateSpecTool.run(
      { file: 'tests/new.spec.ts' },
      repo.toolCtx,
    );
    assert.equal(out.file, 'tests/new.spec.ts');
    assert.ok(out.bytesWritten > 0);

    const disk = await readFile(resolve(repo.repoRoot, 'tests/new.spec.ts'), 'utf8');
    assert.match(disk, /import \{ test, expect \} from '@playwright\/test'/);
  });

  test('includes a describe block when requested', async () => {
    repo = await makeTempRepo();
    await testCreateSpecTool.run(
      { file: 'tests/auth.spec.ts', describe: 'Auth' },
      repo.toolCtx,
    );
    const disk = await readFile(resolve(repo.repoRoot, 'tests/auth.spec.ts'), 'utf8');
    assert.match(disk, /test\.describe\('Auth'/);
  });
});

describe('test.createSpec — refusals', () => {
  let repo: TempRepo;
  afterEach(async () => { if (repo) await repo.cleanup(); });

  test('refuses to overwrite an existing file', async () => {
    repo = await makeTempRepo();
    const existing = await repo.write('tests/existing.spec.ts', '// do not overwrite\n');
    const before = (await stat(existing)).size;

    await assert.rejects(
      () =>
        testCreateSpecTool.run(
          { file: 'tests/existing.spec.ts' },
          repo.toolCtx,
        ),
      /already exists/,
    );

    // Existing file untouched.
    const after = (await stat(existing)).size;
    assert.equal(after, before);
    const disk = await readFile(existing, 'utf8');
    assert.match(disk, /do not overwrite/);
  });

  test('refuses paths outside paths.tests', async () => {
    repo = await makeTempRepo();
    await assert.rejects(
      () =>
        testCreateSpecTool.run(
          { file: 'src/pages/wrong-place.ts' },
          repo.toolCtx,
        ),
      /scope violation.*tests/,
    );
  });
});
