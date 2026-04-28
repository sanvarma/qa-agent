/**
 * Generate the contents of a new, empty Playwright spec file.
 *
 * Shape:
 *   import { test, expect } from '@playwright/test';
 *
 *   test.describe('<name>', () => {
 *   });
 *
 * If `describe` is omitted, the describe block is omitted too — the file
 * is just the import, ready for top-level test(...) calls.
 *
 * Deliberately minimal: no fixtures, no hooks, no config. If a project needs
 * different boilerplate, that's a per-repo concern we'll parameterize later.
 */
export function scaffoldSpec(args) {
    const header = `import { test, expect } from '@playwright/test';\n`;
    if (!args.describe) {
        return header + `\n`;
    }
    const safe = args.describe.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return header + `\ntest.describe('${safe}', () => {\n});\n`;
}
//# sourceMappingURL=specScaffolder.js.map