import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { invalidateSourceFile } from '../../ast/project.js';

const Input = z.object({
  file: z.string().min(1).describe(
    'Path relative to repo root. ' +
    'New common POM: src/pages/common/<ClassName>.ts (flat, NO subdirectories). ' +
    'Locale override: src/pages/locales/<locale>/<ClassName>.ts. ' +
    'WRONG: src/pages/home/HomePage.ts  CORRECT: src/pages/common/HomePage.ts.',
  ),
  className: z.string().min(1).describe('Class name, e.g. ProductDetailPage'),
  gotoPath: z.string().optional().describe("URL path for goto(), e.g. '/products'. Omit if the page has no fixed URL."),
  fields: z.array(z.object({
    name: z.string(),
    selector: z.string(),
    description: z.string().optional(),
  })).default([]).describe('Page object fields to scaffold'),
});
type Input = z.infer<typeof Input>;

interface Output {
  ok: true;
}

export const pomCreatePageTool: Tool<Input, Output> = {
  name: 'pom.createPage',
  description:
    'Create a new Page Object Model class file. TWO MODES:\n' +
    '1. Common POM: file = src/pages/common/<ClassName>.ts (flat, NO subdirectories). ' +
    'Scaffolds a class extending BasePage.\n' +
    '2. Locale override: file = src/pages/locales/<locale>/<ClassName>.ts. ' +
    'Scaffolds a class extending the common class (same ClassName from src/pages/common/). ' +
    'Only override fields/methods that differ — inherited fields are available automatically.\n' +
    'Refuses if the file already exists — use pom.editMethod or pom.updateSelector to modify. ' +
    'SELECTOR QUALITY: never hardcode dynamic values (product names, prices). ' +
    'Use structural CSS paths (e.g. ".product-information h2"). ' +
    'Only use :has-text() for stable labels.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      className: { type: 'string' },
      gotoPath: { type: 'string' },
      fields: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            selector: { type: 'string' },
            description: { type: 'string' },
          },
          required: ['name', 'selector'],
          additionalProperties: false,
        },
        default: [],
      },
    },
    required: ['file', 'className'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const absPath = resolveWithinScope(input.file, 'pages', ctx);

    const isCommon = input.file.startsWith('src/pages/common/');
    const localeMatch = input.file.match(/^src\/pages\/locales\/([^/]+)\/[^/]+\.ts$/);

    if (!isCommon && !localeMatch) {
      throw new Error(
        `pom.createPage: file must be src/pages/common/<Name>.ts (new POM) ` +
        `or src/pages/locales/<locale>/<Name>.ts (locale override). ` +
        `Got: "${input.file}". ` +
        `Did you mean: src/pages/common/${basename(input.file)}?`,
      );
    }

    if (existsSync(absPath)) {
      throw new Error(
        `POM file already exists: ${input.file}. Use pom.editMethod or pom.updateSelector to modify it.`,
      );
    }

    const contents = isCommon
      ? scaffoldCommonPom(input)
      : scaffoldLocaleOverride(input);

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, 'utf8');
    invalidateSourceFile(ctx.repoRoot, absPath);

    return { ok: true };
  },
};

function scaffoldCommonPom(input: Input): string {
  const fieldLines = input.fields.map((f) => {
    const escaped = f.selector.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `  readonly ${f.name} = this.loc("${escaped}");`;
  });

  const gotoMethod = input.gotoPath
    ? [
        '',
        `  override async goto() {`,
        `    await super.goto('${input.gotoPath}');`,
        `    await this.waitForReady();`,
        `  }`,
      ]
    : [];

  return [
    `import { type Page } from '@playwright/test';`,
    `import { BasePage } from '../base/BasePage';`,
    '',
    `export class ${input.className} extends BasePage {`,
    ...fieldLines,
    '',
    `  constructor(page: Page) {`,
    `    super(page);`,
    `  }`,
    ...gotoMethod,
    `}`,
    '',
  ].join('\n');
}

function scaffoldLocaleOverride(input: Input): string {
  // Locale override extends the common class (same className).
  // Import path: ../../common/<ClassName> (locale file is 2 dirs deep: locales/<locale>/)
  const commonImportPath = `../../common/${input.className}`;

  const fieldLines = input.fields.map((f) => {
    const escaped = f.selector.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `  override readonly ${f.name} = this.loc("${escaped}");`;
  });

  const gotoMethod = input.gotoPath
    ? [
        '',
        `  override async goto() {`,
        `    await super.goto('${input.gotoPath}');`,
        `    await this.waitForReady();`,
        `  }`,
      ]
    : [];

  return [
    `import { type Page } from '@playwright/test';`,
    `import { ${input.className} as Base${input.className} } from '${commonImportPath}';`,
    '',
    `export class ${input.className} extends Base${input.className} {`,
    ...fieldLines,
    '',
    `  constructor(page: Page) {`,
    `    super(page);`,
    `  }`,
    ...gotoMethod,
    `}`,
    '',
  ].join('\n');
}
