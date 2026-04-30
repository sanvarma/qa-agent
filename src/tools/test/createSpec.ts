import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, resolve, relative } from 'node:path';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { invalidateSourceFile } from '../../ast/project.js';
import { scaffoldSpec } from '../../ast/scaffoldSpec.js';

const FIXTURE_FILE = 'src/fixtures/pages.fixture.ts';

const Input = z.object({
  file: z.string().min(1).describe('Path relative to repo root; must resolve under paths.tests'),
  describe: z.string().optional().describe('Optional top-level describe to include in the scaffold'),
  serial: z.boolean().optional().describe('Add test.describe.configure({ mode: "serial" }) inside the describe block — required for locale-specific specs'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  bytesWritten: number;
  contents: string;
}

export const testCreateSpecTool: Tool<Input, Output> = {
  name: 'test.createSpec',
  description:
    'Scaffold a new, empty Playwright spec file at the given path under the tests scope. ' +
    'Refuses if the file already exists — use test.addCase to add tests to an existing spec. ' +
    'Always emits the correct `import { test, expect } from \'...\' ` pointing at the pages fixture — ' +
    'do NOT call ast.addImport to add this import yourself. ' +
    'Pass serial:true for any locale-specific spec (tests/locales/*).',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      describe: { type: 'string' },
      serial: { type: 'boolean' },
    },
    required: ['file'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'tests', ctx);

    if (existsSync(absPath)) {
      throw new Error(
        `spec file already exists: ${input.file}. Use test.addCase to add tests to it.`,
      );
    }

    // Compute the relative path from this spec file to the pages fixture.
    const fixtureAbs = resolve(ctx.repoRoot, FIXTURE_FILE);
    let fixtureImport = relative(dirname(absPath), fixtureAbs).replace(/\\/g, '/');
    if (!fixtureImport.startsWith('.')) fixtureImport = `./${fixtureImport}`;
    if (fixtureImport.endsWith('.ts')) fixtureImport = fixtureImport.slice(0, -3);

    const contents = scaffoldSpec({ describe: input.describe, serial: input.serial, fixtureImport });

    // Ensure parent directory exists. The scope helper already guarantees
    // we're under paths.tests, so this mkdir is safe.
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, 'utf8');

    // Drop any stale project cache entry. Matches the pattern used by editCase
    // so a subsequent test.addCase reparses fresh.
    invalidateSourceFile(ctx.repoRoot, absPath);

    return {
      file: input.file,
      bytesWritten: Buffer.byteLength(contents, 'utf8'),
      contents,
    };
  },
};
