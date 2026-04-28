import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ToolContext } from '../../src/tools/tool.js';

export interface TempRepo {
  repoRoot: string;
  runDir: string;
  toolCtx: ToolContext;
  /**
   * Write a file (relative path) under the temp repo, creating parent dirs.
   * Returns the absolute path written.
   */
  write(relPath: string, contents: string): Promise<string>;
  cleanup(): Promise<void>;
}

/**
 * Create a throwaway repo with `src/pages/` and `tests/` directories pre-made,
 * plus a `runDir` for artifact output. Every tool-wrapper test should use a
 * fresh instance and call cleanup() in a finally — we avoid globals so tests
 * can run in parallel if ever needed.
 */
export async function makeTempRepo(): Promise<TempRepo> {
  const repoRoot = await mkdtemp(join(tmpdir(), 'qa-agent-test-'));
  const pagesDir = join(repoRoot, 'src', 'pages');
  const testsDir = join(repoRoot, 'tests');
  const runDir = join(repoRoot, '.qa-agent', 'runs', 'test-run');
  await mkdir(pagesDir, { recursive: true });
  await mkdir(testsDir, { recursive: true });
  await mkdir(runDir, { recursive: true });

  const toolCtx: ToolContext = {
    repoRoot,
    runDir,
    paths: { pages: 'src/pages', tests: 'tests' },
  };

  const write = async (relPath: string, contents: string): Promise<string> => {
    const abs = resolve(repoRoot, relPath);
    await mkdir(join(abs, '..'), { recursive: true });
    await writeFile(abs, contents, 'utf8');
    return abs;
  };

  const cleanup = async (): Promise<void> => {
    await rm(repoRoot, { recursive: true, force: true });
  };

  return { repoRoot, runDir, toolCtx, write, cleanup };
}
