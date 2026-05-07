import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import type { Tool } from '../tool.js';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { addImport } from '../../ast/importEditor.js';
import { SyntaxKind, Node, type SourceFile } from 'ts-morph';

const FIXTURE_FILE = 'src/fixtures/pages.fixture.ts';

const Input = z.object({
  className: z.string().min(1).describe('POM class name, e.g. "ProductsPage"'),
  fixtureName: z.string().min(1).describe('Fixture property name in camelCase, e.g. "productsPage"'),
  importFrom: z.string().min(1).describe(
    'Repo-relative path to the POM file. ' +
    'Common POM (locale omitted): src/pages/common/ProductsPage.ts. ' +
    'Locale override (locale provided): src/pages/locales/<locale>/ProductsPage.ts.',
  ),
  locale: z.string().optional().describe(
    'Locale string, e.g. "es-pr". ' +
    'Omit when registering a new common POM. ' +
    'Provide when adding a locale-specific class override for an existing fixture — ' +
    'the common POM must already be registered.',
  ),
});
type Input = z.infer<typeof Input>;

interface Output {
  ok: true;
  alreadyRegistered: boolean;
}

/** Convert locale string to PascalCase prefix: "es-pr" → "EsPr" */
function localePrefix(locale: string): string {
  return locale.split('-').map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
}

/** Alias used when importing a locale override class to avoid name collision. */
function localeAlias(locale: string, className: string): string {
  return `${localePrefix(locale)}${className}`;
}

function resolveRelImport(absFixture: string, importFrom: string, repoRoot: string): string {
  const targetAbs = resolve(repoRoot, importFrom);
  const fromRoot = relative(repoRoot, targetAbs);
  if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
    throw new Error(
      `importFrom '${importFrom}' resolves outside the repo root. Provide a repo-relative path.`,
    );
  }
  let rel = relative(dirname(absFixture), targetAbs).replace(/\\/g, '/');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  if (rel.endsWith('.ts')) rel = rel.slice(0, -3);
  return rel;
}

export const fixtureAddPageTool: Tool<Input, Output> = {
  name: 'fixture.addPage',
  description:
    'Register a Page Object class in src/fixtures/pages.fixture.ts. TWO MODES:\n' +
    '1. Common POM (locale omitted): registers className as a new fixture with locale-aware instantiation. ' +
    'importFrom MUST be src/pages/common/<Name>.ts. ' +
    'Generates a <fixtureName>ByLocale map and async ({ page, appLocale }, use) => { Cls = map[appLocale] ?? ClassName }.\n' +
    '2. Locale override (locale provided): adds this locale class to the existing fixture locale map. ' +
    'importFrom MUST be src/pages/locales/<locale>/<Name>.ts. ' +
    'The common POM must already be registered (call without locale first). ' +
    'Both modes are idempotent.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      className: { type: 'string' },
      fixtureName: { type: 'string' },
      importFrom: { type: 'string' },
      locale: { type: 'string' },
    },
    required: ['className', 'fixtureName', 'importFrom'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    if (!input.locale) {
      if (!input.importFrom.startsWith('src/pages/common/')) {
        throw new Error(
          `fixture.addPage (common mode): importFrom must be under src/pages/common/. Got: "${input.importFrom}".`,
        );
      }
    } else {
      if (!input.importFrom.includes('src/pages/locales/')) {
        throw new Error(
          `fixture.addPage (locale mode): importFrom must be under src/pages/locales/. Got: "${input.importFrom}".`,
        );
      }
    }

    const absFixture = resolve(ctx.repoRoot, FIXTURE_FILE);
    const beforeSource = await readFile(absFixture, 'utf8');

    const project = getProject(ctx.repoRoot);
    invalidateSourceFile(ctx.repoRoot, absFixture);
    const sf = project.createSourceFile(absFixture, beforeSource, { overwrite: true });

    const rel = resolveRelImport(absFixture, input.importFrom, ctx.repoRoot);

    const result = input.locale
      ? registerLocaleOverride(sf, input as Input & { locale: string }, rel)
      : registerCommonPom(sf, input, rel);

    await sf.save();
    const afterSource = sf.getFullText();
    return {
      ok: true,
      alreadyRegistered: afterSource === beforeSource,
    };
  },
};

// ---------------------------------------------------------------------------
// Mode 1: register a new common POM fixture with locale-aware instantiation
// ---------------------------------------------------------------------------

function registerCommonPom(sf: SourceFile, input: Input, rel: string): void {
  // Idempotency: fixture already registered?
  const existingAlias = sf.getTypeAlias('PageFixtures');
  if (existingAlias) {
    const typeLiteral = existingAlias.getTypeNode();
    if (typeLiteral && typeLiteral.getKind() === SyntaxKind.TypeLiteral) {
      const existing = typeLiteral.asKindOrThrow(SyntaxKind.TypeLiteral).getProperty(input.fixtureName);
      if (existing) return; // already registered
    }
  }

  // 1. Page type import (needed for locale map type annotation)
  addImport(sf, { moduleSpecifier: '@playwright/test', named: ['Page'], typeOnly: true });

  // 2. POM class import
  addImport(sf, { moduleSpecifier: rel, named: [input.className] });

  // 3. Ensure PageFixtures type exists + add property
  let typeAlias = sf.getTypeAlias('PageFixtures');
  if (!typeAlias) {
    const stmts = sf.getStatements();
    let insertIdx = 0;
    for (let i = 0; i < stmts.length; i++) {
      if (Node.isImportDeclaration(stmts[i])) insertIdx = i + 1;
    }
    sf.insertStatements(insertIdx, `\ntype PageFixtures = {};\n`);
    typeAlias = sf.getTypeAlias('PageFixtures')!;
  }

  const typeNode = typeAlias.getTypeNode();
  if (!typeNode || typeNode.getKind() !== SyntaxKind.TypeLiteral) {
    typeAlias.setType(`{ ${input.fixtureName}: ${input.className} }`);
  } else {
    typeNode.asKindOrThrow(SyntaxKind.TypeLiteral).addProperty({
      name: input.fixtureName,
      type: input.className,
    });
  }

  // 4. Ensure test.extend block exists
  let testVar = sf.getVariableDeclaration('test');
  if (!testVar) {
    const stmts = sf.getStatements();
    let insertIdx = stmts.length;
    for (let i = 0; i < stmts.length; i++) {
      if (Node.isExportDeclaration(stmts[i])) { insertIdx = i; break; }
    }
    sf.insertStatements(insertIdx, `\nexport const test = base.extend<PageFixtures>({});\n`);
    testVar = sf.getVariableDeclaration('test')!;
  }

  // 5. Add locale map variable before the test declaration
  const mapVarName = `${input.fixtureName}ByLocale`;
  if (!sf.getVariableDeclaration(mapVarName)) {
    const stmts = sf.getStatements();
    let insertIdx = stmts.length;
    for (let i = 0; i < stmts.length; i++) {
      if (Node.isVariableStatement(stmts[i])) {
        const decls = stmts[i].asKind(SyntaxKind.VariableStatement)
          ?.getDeclarationList()
          ?.getDeclarations() ?? [];
        if (decls.some((d) => d.getName() === 'test')) { insertIdx = i; break; }
      }
    }
    sf.insertStatements(
      insertIdx,
      `\nconst ${mapVarName}: Partial<Record<string, new (p: Page) => ${input.className}>> = {};\n`,
    );
  }

  // 6. Add locale-aware fixture implementation to extend block
  testVar = sf.getVariableDeclaration('test')!;
  const initializer = testVar.getInitializer();
  if (initializer?.getKind() === SyntaxKind.CallExpression) {
    const args = initializer.asKindOrThrow(SyntaxKind.CallExpression).getArguments();
    if (args.length > 0 && args[0].getKind() === SyntaxKind.ObjectLiteralExpression) {
      args[0].asKindOrThrow(SyntaxKind.ObjectLiteralExpression).addPropertyAssignment({
        name: input.fixtureName,
        initializer:
          `async ({ page, appLocale }, use) => {\n` +
          `    const Cls = ${mapVarName}[appLocale] ?? ${input.className};\n` +
          `    await use(new Cls(page));\n` +
          `  }`,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Mode 2: register a locale override for an existing fixture
// ---------------------------------------------------------------------------

function registerLocaleOverride(
  sf: SourceFile,
  input: Input & { locale: string },
  rel: string,
): void {
  const mapVarName = `${input.fixtureName}ByLocale`;
  const mapVar = sf.getVariableDeclaration(mapVarName);
  if (!mapVar) {
    throw new Error(
      `fixture.addPage: locale map '${mapVarName}' not found. ` +
      `Register the common POM first by calling fixture.addPage without the locale parameter.`,
    );
  }

  const alias = localeAlias(input.locale, input.className);
  const localeKey = `'${input.locale}'`;

  // Idempotency: locale key already in map?
  const mapInit = mapVar.getInitializer();
  if (mapInit?.getKind() === SyntaxKind.ObjectLiteralExpression) {
    const obj = mapInit.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    if (obj.getProperty(localeKey)) return; // already registered

    // Add aliased import for the locale class (ts-morph direct — addImport doesn't support aliases)
    const existingDecl = sf
      .getImportDeclarations()
      .find((d) => d.getModuleSpecifierValue() === rel);
    if (existingDecl) {
      const alreadyAliased = existingDecl
        .getNamedImports()
        .some((n) => n.getName() === input.className && (n.getAliasNode()?.getText() ?? n.getName()) === alias);
      if (!alreadyAliased) {
        existingDecl.addNamedImport({ name: input.className, alias });
      }
    } else {
      const allImports = sf.getImportDeclarations();
      sf.insertImportDeclaration(allImports.length, {
        moduleSpecifier: rel,
        namedImports: [{ name: input.className, alias }],
      });
    }

    // Add locale entry to map
    obj.addPropertyAssignment({ name: localeKey, initializer: alias });
  }
}
