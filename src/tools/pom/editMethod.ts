import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { resolveClass } from '../../ast/pomClassResolver.js';
import { findMethod } from '../../ast/pomMethodLocator.js';
import { replaceMethodBody, MethodEditError } from '../../ast/pomMethodEditor.js';
import { unifiedDiff } from '../../ast/diff.js';

const Input = z.object({
  file: z.string().min(1),
  class: z.string().optional(),
  name: z.string().min(1).describe('Method name on the class, e.g. "addAddress"'),
  newBody: z.string().min(1).describe('Raw statements for the method body, no surrounding braces'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  className: string;
  symbolPath: string;         // e.g. "CheckoutPage.addAddress"
  linesChanged: { before: [number, number]; after: [number, number] };
  diff: string;
}

export const pomEditMethodTool: Tool<Input, Output> = {
  name: 'pom.editMethod',
  description:
    'Replace the body of a named instance method on a page-object class. ' +
    'Preserves: method name, parameters, async, static, visibility, return type, decorators, ' +
    'overload signatures. Refuses getters/setters (use pom.updateSelector for those), ' +
    'constructors, abstract methods, and overloaded methods (for now).',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      class: { type: 'string' },
      name: { type: 'string' },
      newBody: { type: 'string' },
    },
    required: ['file', 'name', 'newBody'],
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
    const find = findMethod(cls, input.name);

    switch (find.status) {
      case 'not_found':
        throw new Error(
          `method '${input.name}' not found on class '${cls.getName()}'. ` +
            `Methods in class: ${find.methodCandidates.join(', ') || '(none)'}`,
        );
      case 'is_accessor':
        throw new Error(
          `'${input.name}' is a ${find.kind}, not a method. ` +
            `Use pom.updateSelector for selector ${find.kind}s.`,
        );
      case 'is_constructor':
        throw new Error(`refusing to edit constructor: not supported by this tool`);
      case 'abstract':
        throw new Error(`'${input.name}' is abstract or has no body; nothing to edit`);
      case 'overloaded':
        throw new Error(
          `'${input.name}' is overloaded (signatures at lines ${find.signatureLines.join(', ')}, ` +
            `implementation at line ${find.implementationLine ?? '?'}). ` +
            `Editing overloaded methods is not supported by this tool.`,
        );
    }

    // find.status === 'found'
    const { locator, methodNode } = find;

    try {
      replaceMethodBody(methodNode, input.newBody);
    } catch (err) {
      if (err instanceof MethodEditError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }

    await sf.save();
    const afterSource = sf.getFullText();

    return {
      file: input.file,
      className: locator.className,
      symbolPath: `${locator.className}.${locator.name}`,
      linesChanged: {
        before: [locator.startLine, locator.endLine],
        after: [methodNode.getStartLineNumber(), methodNode.getEndLineNumber()],
      },
      diff: unifiedDiff(beforeSource, afterSource, input.file),
    };
  },
};
