import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { findTestCase } from '../../ast/testLocator.js';
import { replaceTestBody, EditError } from '../../ast/testEditor.js';
import { unifiedDiff } from '../../ast/diff.js';

const Input = z.object({
  file: z.string().min(1),
  title: z.string().min(1),
  describePath: z.array(z.string()).optional(),
  newBody: z
    .string()
    .min(1)
    .describe('Raw statements for the callback body, no surrounding braces'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  symbolPath: string;
  linesChanged: {
    before: [number, number];
    after: [number, number];
  };
  diff: string;
}

export const testEditCaseTool: Tool<Input, Output> = {
  name: 'test.editCase',
  description:
    'Replace the body of a single test case identified by title (and optional describePath). ' +
    'Preserves title, modifiers (.only/.skip/.fixme), callback parameters, and every other test ' +
    'and import in the file. Refuses test.each and expression-bodied callbacks. Returns a unified diff.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      title: { type: 'string' },
      describePath: { type: 'array', items: { type: 'string' } },
      newBody: { type: 'string' },
    },
    required: ['file', 'title', 'newBody'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'tests', ctx);

    // Read the on-disk source FIRST, for a faithful "before" in the diff.
    // We then let ts-morph reparse from this same content.
    const beforeSource = await readFile(absPath, 'utf8');

    const project = getProject(ctx.repoRoot);
    // Force a fresh parse so we never edit against a stale cached version.
    invalidateSourceFile(ctx.repoRoot, absPath);
    const sf = project.createSourceFile(absPath, beforeSource, { overwrite: true });

    const result = findTestCase(sf, {
      title: input.title,
      describePath: input.describePath,
      fileLabel: input.file,
    });

    if (result.status === 'not_found') {
      const hint = result.candidates.length
        ? ` Candidates in file: ${result.candidates
            .map((c) => `${[...c.describePath, c.title].join(' > ')} (L${c.startLine})`)
            .join('; ')}`
        : '';
      throw new Error(`test not found: '${input.title}'.${hint}`);
    }
    if (result.status === 'ambiguous') {
      const hint = result.candidates
        .map((c) => `${[...c.describePath, c.title].join(' > ')} (L${c.startLine})`)
        .join('; ');
      throw new Error(`test title '${input.title}' is ambiguous. Pass describePath to disambiguate. Matches: ${hint}`);
    }

    const { locator, node } = result;

    if (locator.isEach) {
      throw new Error(
        `refusing to edit parameterized test (test.each): '${input.title}'. ` +
          'Parameterized tests are not a supported edit target.',
      );
    }

    try {
      replaceTestBody(node, input.newBody);
    } catch (err) {
      if (err instanceof EditError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }

    // Persist to disk and recompute locator boundaries on the edited AST.
    await sf.save();
    const afterSource = sf.getFullText();

    // After save, re-query the test to get the new line range. The AST mutates
    // in place, so `node` still points at the edited call — we can use it directly.
    const afterStart = node.getStartLineNumber();
    const afterEnd = node.getEndLineNumber();

    return {
      file: input.file,
      symbolPath: [...locator.describePath, locator.title].join(' > '),
      linesChanged: {
        before: [locator.startLine, locator.endLine],
        after: [afterStart, afterEnd],
      },
      diff: unifiedDiff(beforeSource, afterSource, input.file),
    };
  },
};
