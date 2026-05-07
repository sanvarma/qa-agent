import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { resolveClass } from '../../ast/pomClassResolver.js';
import { insertPomField, InsertFieldError } from '../../ast/pomFieldInserter.js';

const Input = z.object({
  file: z.string().min(1).describe(
    'Path relative to repo root; must resolve under paths.pages. ' +
    'E.g. src/pages/common/ProductsPage.ts',
  ),
  class: z.string().optional().describe('Target class name. Omit if the file has exactly one class.'),
  name: z.string().min(1).describe('Field name, e.g. "searchInput"'),
  selector: z.string().min(1).describe('CSS/attribute selector string, e.g. "#search-input" or ".product-card"'),
  description: z.string().optional().describe('Optional JSDoc comment for the field'),
});
type Input = z.infer<typeof Input>;

interface Output {
  ok: true;
}

export const pomAddSelectorTool: Tool<Input, Output> = {
  name: 'pom.addSelector',
  description:
    'Add a new readonly selector field to an existing Page Object class. ' +
    'Emits: `readonly <name> = this.loc("<selector>");` inserted after the last existing readonly field. ' +
    'Refuses if a member with the same name already exists — use pom.updateSelector instead. ' +
    'Refuses if the file does not exist — use pom.createPage for new files. ' +
    'SELECTOR QUALITY: selectors must work for any page instance. ' +
    'Never hardcode dynamic values (product names, prices). ' +
    'Use structural CSS (e.g. ".product-information h2") for dynamic content. ' +
    'Only use :has-text() for stable labels that never change (e.g. "Category:", "Brand:").',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      class: { type: 'string' },
      name: { type: 'string' },
      selector: { type: 'string' },
      description: { type: 'string' },
    },
    required: ['file', 'name', 'selector'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'pages', ctx);

    if (!existsSync(absPath)) {
      throw new Error(
        `POM file not found: ${input.file}. Use pom.createPage to create a new file.`,
      );
    }

    const beforeSource = await readFile(absPath, 'utf8');

    const project = getProject(ctx.repoRoot);
    invalidateSourceFile(ctx.repoRoot, absPath);
    const sf = project.createSourceFile(absPath, beforeSource, { overwrite: true });

    const clsResult = resolveClass(sf, input.class);
    if (clsResult.status === 'no_class') {
      throw new Error(`no class found in ${input.file}`);
    }
    if (clsResult.status === 'not_found') {
      throw new Error(
        `class '${input.class}' not found in ${input.file}. ` +
        `Classes in file: ${clsResult.candidates.join(', ') || '(none)'}`,
      );
    }
    if (clsResult.status === 'ambiguous') {
      throw new Error(
        `multiple classes in ${input.file}: ${clsResult.candidates.join(', ')}. Pass 'class' to disambiguate.`,
      );
    }

    const cls = clsResult.cls;

    try {
      const inserted = insertPomField(cls, {
        name: input.name,
        selector: input.selector,
        description: input.description,
      });

      await sf.save();

      return { ok: true };
    } catch (err) {
      if (err instanceof InsertFieldError) {
        if (err.code === 'duplicate_field') {
          throw new Error(
            `${err.message}. Use pom.updateSelector to change its selector instead.`,
          );
        }
        throw new Error(err.message);
      }
      throw err;
    }
  },
};
