/**
 * Generate the contents of a new, empty Playwright spec file.
 *
 * Always emits `import { test, expect } from '<fixtureImport>'` so the
 * agent never has to construct the fixture import path by hand.
 *
 * If `describe` is supplied an empty describe block is added.
 * If `serial` is true, `test.describe.configure({ mode: 'serial' })` is
 * added inside the block (for locale-specific specs).
 */
export function scaffoldSpec(args: {
  describe?: string;
  serial?: boolean;
  fixtureImport: string;
}): string {
  const importLine = `import { test, expect } from '${args.fixtureImport}';`;
  if (!args.describe) {
    return `${importLine}\n`;
  }
  const safe = args.describe.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const serialLine = args.serial ? `  test.describe.configure({ mode: 'serial' });\n` : '';
  return `${importLine}\n\ntest.describe('${safe}', () => {\n${serialLine}});\n`;
}
