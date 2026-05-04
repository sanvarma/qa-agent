import { z } from 'zod';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname, resolve } from 'node:path';
import { Project, type SourceFile } from 'ts-morph';
import type { Tool } from '../tool.js';

const Input = z.object({});
type Input = z.infer<typeof Input>;

interface MethodSig {
  name: string;
  /** Full signature string e.g. "goto(): Promise<void>" */
  signature: string;
}

interface LocaleOverride {
  file: string;
  fields: string[];
  methods: MethodSig[];
}

interface PageInfo {
  /** Relative path from repo root */
  file: string;
  className: string;
  extends: string | null;
  /** Registered fixture name, or null if not registered */
  fixture: string | null;
  /** Names of all this.loc(...) fields */
  fields: string[];
  /** Public method signatures (no bodies) */
  methods: MethodSig[];
  localeOverrides: Record<string, LocaleOverride>;
}

interface Output {
  /** Keyed by file basename without extension e.g. "LoginPage" */
  pages: Record<string, PageInfo>;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function parseClass(sf: SourceFile): {
  className: string;
  extendsName: string | null;
  fields: string[];
  methods: MethodSig[];
} | null {
  const classes = sf.getClasses();
  if (classes.length === 0) return null;

  const cls = classes[0];
  const className = cls.getName() ?? '';

  const extendsExpr = cls.getExtends();
  const extendsName = extendsExpr ? extendsExpr.getExpression().getText() : null;

  const fields = cls
    .getProperties()
    .filter((p) => !p.isStatic() && p.getInitializer()?.getText().startsWith('this.loc('))
    .map((p) => p.getName());

  const methods: MethodSig[] = cls
    .getMethods()
    .filter((m) => !m.isStatic() && m.getName() !== 'constructor')
    .map((m) => {
      const params = m
        .getParameters()
        .map((p) => {
          const typeNode = p.getTypeNode();
          const typeTxt = typeNode ? typeNode.getText() : 'unknown';
          const opt = p.hasQuestionToken() ? '?' : '';
          return `${p.getName()}${opt}: ${typeTxt}`;
        })
        .join(', ');
      const returnTypeNode = m.getReturnTypeNode();
      const returnType = returnTypeNode ? returnTypeNode.getText() : 'void';
      return { name: m.getName(), signature: `${m.getName()}(${params}): ${returnType}` };
    });

  return { className, extendsName, fields, methods };
}

/**
 * Parse pages.fixture.ts imports to get className → absolute file path.
 * This is the source of truth for which POMs are actually used — regardless
 * of what directory they live in.
 */
function parseImports(fixturePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(fixturePath)) return map;

  const content = readFileSync(fixturePath, 'utf8');
  const fixtureDir = dirname(fixturePath);

  // Match: import { ClassName } from '../pages/...'
  const re = /import\s*\{\s*(\w+)\s*\}\s*from\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const [, className, relPath] = m;
    if (!relPath.includes('pages')) continue;
    const absPath = resolve(fixtureDir, relPath.endsWith('.ts') ? relPath : relPath + '.ts');
    map.set(className, absPath);
  }
  return map;
}

/** className → fixtureName from the extend block */
function parseFixtureNames(fixturePath: string): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(fixturePath)) return map;

  const content = readFileSync(fixturePath, 'utf8');
  const re = /^\s*(\w+):\s*async.*new\s+(\w+)\s*\(page\)/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    const [, fixtureName, className] = m;
    map.set(className, fixtureName);
  }
  return map;
}

function scanTsFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))
    .map((f) => join(dir, f));
}

function scanLocales(localesDir: string): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  if (!existsSync(localesDir)) return result;
  for (const entry of readdirSync(localesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const files = scanTsFiles(join(localesDir, entry.name));
    if (files.length > 0) result[entry.name] = files;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const frameworkGetGraphTool: Tool<Input, Output> = {
  name: 'framework.getGraph',
  description:
    'Returns the complete framework graph: every registered POM with its field names, method ' +
    'signatures (no bodies), fixture name, and locale overrides. Derives the POM list from ' +
    'pages.fixture.ts imports — works regardless of which subdirectory POMs live in. ' +
    'Call ONCE at step 1 alongside fs.read of the target spec file. ' +
    'Only use fields, methods, and fixture names that appear in this output — never guess.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  async run(_input, ctx) {
    const project = new Project({ useInMemoryFileSystem: false, skipAddingFilesFromTsConfig: true });

    const fixturePath = join(ctx.repoRoot, 'src', 'fixtures', 'pages.fixture.ts');
    const localesDir = join(ctx.repoRoot, 'src', 'pages', 'locales');

    // Source of truth: what's imported in pages.fixture.ts
    const importMap = parseImports(fixturePath);       // className → absPath
    const fixtureNames = parseFixtureNames(fixturePath); // className → fixtureName

    const pages: Record<string, PageInfo> = {};

    for (const [className, absPath] of importMap) {
      if (!existsSync(absPath)) continue;
      const sf = project.addSourceFileAtPath(absPath);
      const parsed = parseClass(sf);
      if (!parsed) continue;

      const key = basename(absPath, '.ts');
      pages[key] = {
        file: relative(ctx.repoRoot, absPath).replace(/\\/g, '/'),
        className: parsed.className,
        extends: parsed.extendsName,
        fixture: fixtureNames.get(className) ?? null,
        fields: parsed.fields,
        methods: parsed.methods,
        localeOverrides: {},
      };
    }

    // Locale overrides
    const localeFiles = scanLocales(localesDir);
    for (const [locale, files] of Object.entries(localeFiles)) {
      for (const filePath of files) {
        const sf = project.addSourceFileAtPath(filePath);
        const parsed = parseClass(sf);
        if (!parsed) continue;

        const key = basename(filePath, '.ts');
        if (pages[key]) {
          pages[key].localeOverrides[locale] = {
            file: relative(ctx.repoRoot, filePath).replace(/\\/g, '/'),
            fields: parsed.fields,
            methods: parsed.methods,
          };
        }
      }
    }

    return { pages };
  },
};
