import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { resolveClass } from '../../ast/pomClassResolver.js';
import { findSelectorField } from '../../ast/pomSelectorLocator.js';
import { replaceSelectorStringArg } from '../../ast/pomSelectorEditor.js';
import { unifiedDiff } from '../../ast/diff.js';

const Input = z.object({
  file: z.string().min(1).describe('Path relative to repo root; must resolve under paths.pages'),
  class: z.string().optional().describe('Target class. Omit if file has exactly one class.'),
  name: z.string().min(1).describe('Selector field name (e.g., "emailField")'),
  newSelector: z.string().min(1).describe('New selector string to write as the first argument'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  className: string;
  name: string;
  method: string;            // the locator method, e.g. "locator" or "getByTestId"
  before: string;            // previous selector string
  after: string;             // new selector string
  linesChanged: { before: [number, number]; after: [number, number] };
  diff: string;
}

export const pomUpdateSelectorTool: Tool<Input, Output> = {
  name: 'pom.updateSelector',
  description:
    'Update the selector string of a field-initializer selector on a page-object class. ' +
    'Supported shape: `name = this.page.<call>(\'selector\')` or `name = this.loc(\'selector\')` where <call> is one of ' +
    'locator/loc/getByTestId/getByText/getByLabel/getByPlaceholder/getByAltText/getByTitle. ' +
    'Refuses getByRole and chained locators. Preserves call type; replaces only the first string arg.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      class: { type: 'string' },
      name: { type: 'string' },
      newSelector: { type: 'string' },
    },
    required: ['file', 'name', 'newSelector'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'pages', ctx);
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
        `class '${input.class}' not found in ${input.file}. Classes in file: ${clsResult.candidates.join(', ') || '(none)'}`,
      );
    }
    if (clsResult.status === 'ambiguous') {
      throw new Error(
        `multiple classes in ${input.file}: ${clsResult.candidates.join(', ')}. Pass 'class' to disambiguate.`,
      );
    }

    const cls = clsResult.cls;
    const find = findSelectorField(cls, input.name);

    switch (find.status) {
      case 'not_found':
        throw new Error(
          `field '${input.name}' not found on class '${cls.getName()}'. ` +
            `Fields in class: ${find.fieldCandidates.join(', ') || '(none)'}`,
        );
      case 'not_a_selector_field':
        throw new Error(
          `'${input.name}' is not a selector field: ${find.reason}. ` +
            `Expected shape: \`${input.name} = this.page.locator('...')\` or \`${input.name} = this.loc('...')\`.`,
        );
      case 'chained_selectors':
        throw new Error(
          `'${input.name}' uses chained locators (e.g. .locator(...).locator(...)). ` +
            `Refused: chained selectors require a broader edit than this tool supports.`,
        );
      case 'role_based_selector':
        throw new Error(
          `'${input.name}' uses getByRole, whose first arg is a role, not a selector. ` +
            `Refused: use pom.editMethod to change role-based lookups.`,
        );
      case 'unsupported_call':
        throw new Error(
          `'${input.name}' uses unsupported locator call '${find.callName}'. ` +
            `Supported: locator, loc, getByTestId, getByText, getByLabel, getByPlaceholder, getByAltText, getByTitle.`,
        );
      case 'non_string_selector':
        throw new Error(
          `'${input.name}' does not have a string literal as its first argument. ` +
            `Refused: this tool only swaps literal selector strings.`,
        );
    }

    // find.status === 'found'
    const { locator, callNode } = find;
    const before = locator.currentSelector;

    if (before === input.newSelector) {
      // Idempotent no-op. Still return a valid result so the LLM sees it worked.
      return {
        file: input.file,
        className: locator.className,
        name: locator.name,
        method: locator.method,
        before,
        after: input.newSelector,
        linesChanged: {
          before: [locator.startLine, locator.endLine],
          after: [locator.startLine, locator.endLine],
        },
        diff: '',
      };
    }

    replaceSelectorStringArg(callNode, input.newSelector);
    await sf.save();
    const afterSource = sf.getFullText();

    // Recompute bounds after edit.
    // The property node didn't move vertically (single-line swap), but we
    // recompute to be correct for multi-line selector strings.
    const afterStart = find.propertyNode.getStartLineNumber();
    const afterEnd = find.propertyNode.getEndLineNumber();

    return {
      file: input.file,
      className: locator.className,
      name: locator.name,
      method: locator.method,
      before,
      after: input.newSelector,
      linesChanged: {
        before: [locator.startLine, locator.endLine],
        after: [afterStart, afterEnd],
      },
      diff: unifiedDiff(beforeSource, afterSource, input.file),
    };
  },
};
