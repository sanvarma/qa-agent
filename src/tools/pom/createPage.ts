import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Tool } from '../tool.js';
import { resolveWithinScope } from '../util/scope.js';
import { invalidateSourceFile } from '../../ast/project.js';

const Input = z.object({
  file: z.string().min(1).describe(
    'Path relative to repo root; must resolve under paths.pages. ' +
    'E.g. src/pages/common/ProductDetailPage.ts',
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
  file: string;
  bytesWritten: number;
  contents: string;
}

export const pomCreatePageTool: Tool<Input, Output> = {
  name: 'pom.createPage',
  description:
    'Create a new Page Object Model class file under src/pages/. ' +
    'Refuses if the file already exists — use pom.editMethod or pom.updateSelector on an existing POM. ' +
    'Scaffolds a class extending BasePage with the given fields and an optional goto(). ' +
    'SELECTOR QUALITY: field selectors must work for any page instance, not just the one currently browsed. ' +
    'Never hardcode dynamic values (product names, prices, user-specific text) into selectors. ' +
    'Use structural CSS paths (e.g. ".product-information h2") for dynamic content. ' +
    'Only use :has-text() for stable labels that never change (e.g. "Category:", "Brand:").',
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

    if (existsSync(absPath)) {
      throw new Error(
        `POM file already exists: ${input.file}. Use pom.editMethod or pom.updateSelector to modify it.`,
      );
    }

    const contents = scaffoldPom(input);

    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, contents, 'utf8');
    invalidateSourceFile(ctx.repoRoot, absPath);

    return { file: input.file, bytesWritten: Buffer.byteLength(contents, 'utf8'), contents };
  },
};

function scaffoldPom(input: Input): string {
  const fieldLines = input.fields.map((f) => {
    // Use double quotes so selectors containing single quotes (e.g. :has-text('foo')) are valid TS.
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
