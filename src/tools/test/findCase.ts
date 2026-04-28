import { z } from 'zod';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject } from '../../ast/project.js';
import { findTestCase } from '../../ast/testLocator.js';
import type { TestLocator, Candidate } from '../../ast/testLocator.js';

const Input = z.object({
  file: z.string().min(1).describe('Path relative to repo root; must resolve under paths.tests'),
  title: z.string().min(1).describe('Exact test title'),
  describePath: z
    .array(z.string())
    .optional()
    .describe('Enclosing describes, outermost first. Use to disambiguate nested describes.'),
});
type Input = z.infer<typeof Input>;

type Output =
  | { status: 'found'; locator: TestLocator }
  | { status: 'not_found'; candidates: Candidate[] }
  | { status: 'ambiguous'; candidates: Candidate[] };

export const testFindCaseTool: Tool<Input, Output> = {
  name: 'test.findCase',
  description:
    'Locate a test case by exact title (and optional describePath) in a Playwright spec file. ' +
    'Returns a locator pointer (file, describePath, title, line range). Does not return source — ' +
    'use fs.read with the returned line range if you need to see the body. On ambiguity or miss, ' +
    'returns candidates to help narrow the next call.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      title: { type: 'string' },
      describePath: {
        type: 'array',
        items: { type: 'string' },
        description: 'Outermost describe first. Omit or empty array means "any".',
      },
    },
    required: ['file', 'title'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'tests', ctx);

    const project = getProject(ctx.repoRoot);
    // Add or refresh the source file from disk. addSourceFileAtPath is a no-op
    // if already loaded; the user can explicitly invalidate via the project helper.
    let sf = project.getSourceFile(absPath);
    if (!sf) {
      sf = project.addSourceFileAtPathIfExists(absPath);
      if (!sf) throw new Error(`file not found: ${input.file}`);
    }

    const result = findTestCase(sf, {
      title: input.title,
      describePath: input.describePath,
      fileLabel: input.file,
    });

    if (result.status === 'found') {
      return { status: 'found', locator: result.locator };
    }
    return { status: result.status, candidates: result.candidates };
  },
};
