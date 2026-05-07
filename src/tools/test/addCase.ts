import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { insertTestCase, InsertError } from '../../ast/testInserter.js';
import { unifiedDiff } from '../../ast/diff.js';

// ---------------------------------------------------------------------------
// testData field validation helpers
// ---------------------------------------------------------------------------

async function findJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = join(dir, e);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) results.push(...(await findJsonFiles(full)));
    else if (e.endsWith('.json')) results.push(full);
  }
  return results;
}

async function loadSchemaFields(dataRoot: string, key: string): Promise<string[] | null> {
  const files = await findJsonFiles(dataRoot);
  for (const f of files) {
    let parsed: Record<string, unknown[]>;
    try {
      parsed = JSON.parse(await readFile(f, 'utf8')) as Record<string, unknown[]>;
    } catch {
      continue;
    }
    const records = parsed[key];
    if (!Array.isArray(records) || records.length === 0) continue;
    const first = records[0];
    if (first && typeof first === 'object') return Object.keys(first);
  }
  return null;
}

// Parse body for: const varName = testData<...>('key') or testData('key')
function parseTestDataBindings(body: string): Array<{ varName: string; key: string }> {
  const bindings: Array<{ varName: string; key: string }> = [];
  // matches: const/let/var varName = testData<...>('key') or testData('key')
  const re = /(?:const|let|var)\s+(\w+)\s*=\s*testData(?:<[^>]*>)?\(\s*['"`](\w+)['"`]\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    bindings.push({ varName: m[1], key: m[2] });
  }
  return bindings;
}

// Find all property accesses on a variable: varName.field
function findFieldAccesses(body: string, varName: string): string[] {
  const fields = new Set<string>();
  // avoid matching varName as part of another identifier
  const re = new RegExp(`\\b${varName}\\.(\\w+)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    fields.add(m[1]);
  }
  return [...fields];
}

async function validateTestDataFields(body: string, dataRoot: string): Promise<void> {
  const bindings = parseTestDataBindings(body);
  for (const { varName, key } of bindings) {
    const schemaFields = await loadSchemaFields(dataRoot, key);
    if (schemaFields === null) continue; // unknown key — let runtime catch it
    const accessed = findFieldAccesses(body, varName);
    const invalid = accessed.filter(f => !schemaFields.includes(f));
    if (invalid.length > 0) {
      throw new Error(
        `testData field mismatch for key '${key}': ` +
        `field(s) [${invalid.map(f => `'${f}'`).join(', ')}] do not exist. ` +
        `Valid fields: ${schemaFields.map(f => `'${f}'`).join(', ')}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------

const Input = z.object({
  file: z.string().min(1).describe('Path relative to repo root; must resolve under paths.tests'),
  title: z.string().min(1),
  describe: z.string().optional().describe('Top-level describe to insert into; omit for top-level test'),
  body: z.string().min(1).describe('Raw statements for the test callback body, no surrounding braces'),
  fixtures: z.array(z.string()).optional().describe('Fixture names to destructure from test args, e.g. ["productsPage", "productDetailPage"]. page is always included. Do NOT include these as imports — they are injected by Playwright.'),
  position: z.enum(['start', 'end']).optional().default('end'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  symbolPath: string;
  insertedAt: { startLine: number; endLine: number };
  diff: string;
}

export const testAddCaseTool: Tool<Input, Output> = {
  name: 'test.addCase',
  description:
    'Insert a new test case into an existing spec file. ' +
    'Pass fixtures[] with the page-object fixture names the test needs (e.g. ["productsPage", "productDetailPage"]) — ' +
    'they will be destructured from the test function args automatically: async ({ page, productsPage, productDetailPage }) => { ... }. ' +
    'page is always included. Do NOT import fixture names at module level — they are injected by Playwright. ' +
    'Tests are ALWAYS inserted inside a describe block. If describe is provided, it is used (created if absent). ' +
    'If describe is omitted, the tool uses the existing describe block in the file; if none exists, it creates one named after the spec file. ' +
    'Refuses if a test with the same title already exists anywhere in the file. ' +
    'Does NOT create the spec file — use test.createSpec for that.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      title: { type: 'string' },
      describe: { type: 'string' },
      body: { type: 'string' },
      fixtures: { type: 'array', items: { type: 'string' } },
      position: { type: 'string', enum: ['start', 'end'], default: 'end' },
    },
    required: ['file', 'title', 'body'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'tests', ctx);
    if (!existsSync(absPath)) {
      throw new Error(`spec file not found: ${input.file}. Use test.createSpec to scaffold it first.`);
    }

    const dataRoot = resolve(ctx.repoRoot, 'src', 'data');
    await validateTestDataFields(input.body, dataRoot);

    const beforeSource = await readFile(absPath, 'utf8');

    const project = getProject(ctx.repoRoot);
    invalidateSourceFile(ctx.repoRoot, absPath);
    const sf = project.createSourceFile(absPath, beforeSource, { overwrite: true });

    let inserted;
    try {
      inserted = insertTestCase(sf, {
        title: input.title,
        describe: input.describe,
        body: input.body,
        fixtures: input.fixtures,
        position: input.position ?? 'end',
      });
    } catch (err) {
      if (err instanceof InsertError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }

    await sf.save();
    const afterSource = sf.getFullText();

    return {
      file: input.file,
      symbolPath: input.describe ? `${input.describe} > ${input.title}` : input.title,
      insertedAt: inserted,
      diff: unifiedDiff(beforeSource, afterSource, input.file),
    };
  },
};
