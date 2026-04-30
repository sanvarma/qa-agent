import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { Tool, ToolContext } from '../tool.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { addImport } from '../../ast/importEditor.js';
import { unifiedDiff } from '../../ast/diff.js';
import { SyntaxKind } from 'ts-morph';

const FIXTURE_FILE = 'src/fixtures/pages.fixture.ts';

const Input = z.object({
  className: z.string().min(1).describe('POM class name, e.g. "ProductsPage"'),
  fixtureName: z.string().min(1).describe('Fixture property name in camelCase, e.g. "productsPage"'),
  importFrom: z.string().min(1).describe('Repo-relative path to the POM file, e.g. "src/pages/common/ProductsPage.ts"'),
});
type Input = z.infer<typeof Input>;

interface Output {
  file: string;
  changed: boolean;
  diff: string;
}

export const fixtureAddPageTool: Tool<Input, Output> = {
  name: 'fixture.addPage',
  description:
    'Register a Page Object class as a fixture in src/fixtures/pages.fixture.ts. ' +
    'Idempotent — returns changed:false if the fixture already exists. ' +
    'Adds the import, adds the fixture name to the PageFixtures type, and adds a simple ' +
    '`async ({ page }, use) => { await use(new ClassName(page)); }` implementation. ' +
    'After calling this, tests can destructure the fixture from test args instead of calling new ClassName(page).',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      className: { type: 'string' },
      fixtureName: { type: 'string' },
      importFrom: { type: 'string' },
    },
    required: ['className', 'fixtureName', 'importFrom'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absFixture = resolve(ctx.repoRoot, FIXTURE_FILE);
    const beforeSource = await readFile(absFixture, 'utf8');

    const project = getProject(ctx.repoRoot);
    invalidateSourceFile(ctx.repoRoot, absFixture);
    const sf = project.createSourceFile(absFixture, beforeSource, { overwrite: true });

    // Check if fixture already registered (idempotent).
    const typeAlias = sf.getTypeAlias('PageFixtures');
    if (typeAlias) {
      const typeLiteral = typeAlias.getTypeNode();
      if (typeLiteral && typeLiteral.getKind() === SyntaxKind.TypeLiteral) {
        const existing = typeLiteral.asKindOrThrow(SyntaxKind.TypeLiteral).getProperty(input.fixtureName);
        if (existing) {
          return { file: FIXTURE_FILE, changed: false, diff: '' };
        }
      }
    }

    // 1. Add import for the POM class.
    const targetAbs = resolve(ctx.repoRoot, input.importFrom);
    const fromRoot = relative(ctx.repoRoot, targetAbs);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
      throw new Error(
        `importFrom '${input.importFrom}' resolves outside the repo root. ` +
        `Provide a repo-relative path, e.g. 'src/pages/common/${input.className}.ts'`,
      );
    }
    let rel = relative(dirname(absFixture), targetAbs).replace(/\\/g, '/');
    if (!rel.startsWith('.')) rel = `./${rel}`;
    if (rel.endsWith('.ts')) rel = rel.slice(0, -3);

    addImport(sf, { moduleSpecifier: rel, named: [input.className] });

    // 2. Add to PageFixtures type.
    if (typeAlias) {
      const typeNode = typeAlias.getTypeNode();
      if (typeNode && typeNode.getKind() !== SyntaxKind.TypeLiteral) {
        // Replace non-literal type (e.g. Record<string, never>) with a proper object type.
        typeAlias.setType(`{ ${input.fixtureName}: ${input.className} }`);
      } else if (typeNode && typeNode.getKind() === SyntaxKind.TypeLiteral) {
        typeNode.asKindOrThrow(SyntaxKind.TypeLiteral).addProperty({
          name: input.fixtureName,
          type: input.className,
        });
      }
    }

    // 3. Add fixture implementation to base.extend({...}).
    const testVar = sf.getVariableDeclaration('test');
    if (testVar) {
      const initializer = testVar.getInitializer();
      if (initializer && initializer.getKind() === SyntaxKind.CallExpression) {
        const callExpr = initializer.asKindOrThrow(SyntaxKind.CallExpression);
        const args = callExpr.getArguments();
        if (args.length > 0 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
          const obj = args[0].asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
          obj.addPropertyAssignment({
            name: input.fixtureName,
            initializer: `async ({ page }, use) => {\n    await use(new ${input.className}(page));\n  }`,
          });
        }
      }
    }

    await sf.save();
    const afterSource = sf.getFullText();

    return {
      file: FIXTURE_FILE,
      changed: true,
      diff: unifiedDiff(beforeSource, afterSource, FIXTURE_FILE),
    };
  },
};
