import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { resolveClass } from '../../ast/pomClassResolver.js';
import { findMethod } from '../../ast/pomMethodLocator.js';
import { replaceMethodBody, addMethod, MethodEditError } from '../../ast/pomMethodEditor.js';
import { unifiedDiff } from '../../ast/diff.js';

const Input = z.object({
  file: z.string().min(1),
  class: z.string().optional(),
  name: z.string().min(1).describe('Method name on the class, e.g. "login"'),
  newBody: z.string().min(1).describe('Raw statements for the method body, no surrounding braces'),
  // Used only when creating a new method (ignored when method already exists)
  params: z.string().optional().describe(
    'Parameter list for a NEW method, e.g. "username: string, password: string". Ignored when replacing.',
  ),
  isAsync: z.boolean().optional().describe('Whether the new method is async. Ignored when replacing.'),
  returnType: z.string().optional().describe('Return type for a new method. Ignored when replacing.'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  className: string;
  symbolPath: string;
  created: boolean;
  linesChanged: { before: [number, number] | null; after: [number, number] };
  diff: string;
}

export const pomEditMethodTool: Tool<Input, Output> = {
  name: 'pom.editMethod',
  description:
    'Add or replace a named instance method on a page-object class. ' +
    'If the method does not exist it is created using params/isAsync/returnType. ' +
    'If it already exists its body is replaced and the existing signature is preserved. ' +
    'Refuses getters/setters (use pom.updateSelector for those), ' +
    'constructors, abstract methods, and overloaded methods.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      class: { type: 'string' },
      name: { type: 'string' },
      newBody: { type: 'string' },
      params: { type: 'string', default: '' },
      isAsync: { type: 'boolean', default: true },
      returnType: { type: 'string', default: 'Promise<void>' },
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

    // Refuse accessors, constructors, abstract, overloaded — regardless of create/replace.
    switch (find.status) {
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

    try {
      if (find.status === 'not_found') {
        // CREATE path
        const methodNode = addMethod(cls, {
          name: input.name,
          params: input.params ?? '',
          isAsync: input.isAsync ?? true,
          returnType: input.returnType ?? 'Promise<void>',
          body: input.newBody,
        });

        await sf.save();
        const afterSource = sf.getFullText();

        return {
          file: input.file,
          className: cls.getName()!,
          symbolPath: `${cls.getName()}.${input.name}`,
          created: true,
          linesChanged: {
            before: null,
            after: [methodNode.getStartLineNumber(), methodNode.getEndLineNumber()],
          },
          diff: unifiedDiff(beforeSource, afterSource, input.file),
        };
      }

      // REPLACE path — find.status === 'found'
      const { locator, methodNode } = find;
      replaceMethodBody(methodNode, input.newBody);

      await sf.save();
      const afterSource = sf.getFullText();

      return {
        file: input.file,
        className: locator.className,
        symbolPath: `${locator.className}.${locator.name}`,
        created: false,
        linesChanged: {
          before: [locator.startLine, locator.endLine],
          after: [methodNode.getStartLineNumber(), methodNode.getEndLineNumber()],
        },
        diff: unifiedDiff(beforeSource, afterSource, input.file),
      };
    } catch (err) {
      if (err instanceof MethodEditError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err;
    }
  },
};
