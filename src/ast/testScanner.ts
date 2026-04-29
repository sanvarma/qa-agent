import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { getProject } from './project.js';
import { findTestCase } from './testLocator.js';

function collectSpecFiles(dir: string): string[] {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      results.push(...collectSpecFiles(full));
    } else if (entry.endsWith('.spec.ts') || entry.endsWith('.spec.js')) {
      results.push(full);
    }
  }
  return results;
}

export interface ExistingTestLocation {
  absPath: string;
  repoRelativePath: string;
}

/**
 * Scan all spec files under testsDir for a test with the given exact title.
 * Returns the first match found, or null if the title doesn't exist anywhere.
 */
export function findTestAcrossSpecs(
  title: string,
  testsDir: string,
  repoRoot: string,
): ExistingTestLocation | null {
  const files = collectSpecFiles(testsDir);
  const project = getProject(repoRoot);

  for (const absPath of files) {
    let sf = project.getSourceFile(absPath);
    if (!sf) {
      sf = project.addSourceFileAtPathIfExists(absPath);
    }
    if (!sf) continue;

    const repoRelativePath = relative(repoRoot, absPath).replace(/\\/g, '/');
    const result = findTestCase(sf, { title, fileLabel: repoRelativePath });
    if (result.status === 'found') {
      return { absPath, repoRelativePath };
    }
  }

  return null;
}
