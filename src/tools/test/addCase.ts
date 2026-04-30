import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { insertTestCase, InsertError } from '../../ast/testInserter.js';
import { unifiedDiff } from '../../ast/diff.js';

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
    'If a describe is provided, inserts inside that top-level describe; otherwise at top level. ' +
    'Refuses if a test with the same title already exists in the target scope. ' +
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
