import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const ConfigSchema = z.object({
  model: z.string().default('unset'),
  maxSteps: z.number().int().positive().default(12),
  maxTokens: z.number().int().positive().default(4096),
  maxFixAttempts: z.number().int().positive().default(1),
  maxRetryAttempts: z.number().int().positive().default(1),
  // Validation command is wired here now so the future exec.runTests tool reads from one place.
  validation: z
    .object({
      command: z.string().default('npx playwright test --reporter=json'),
      cwd: z.string().optional(),
    })
    .default({ command: 'npx playwright test --reporter=json' }),
  // Target-repo layout. Config-driven so we can swap frameworks later
  // without moving files. All paths are relative to repoRoot.
  // Mutating tools will enforce write scope against these.
  paths: z
    .object({
      pages: z.string().default('src/pages'),
      tests: z.string().default('tests'),
    })
    .default({ pages: 'src/pages', tests: 'tests' }),
  // Optional browse/discovery block. If absent, no MCP server is launched and
  // no browse.* tools are exposed — the agent works exactly as it does without
  // discovery. Presence of `appUrl` is the trigger: we require at minimum a URL
  // to give `browser_navigate` a meaningful target.
  // Optional config-driven setup flows for auth-gated page extraction.
  // Each flow is a named sequence of steps executed before DOM extraction.
  // Steps can reference existing POM fields (pom+field) or use direct selectors.
  // Falls back to built-in generic sequences if a flow is not defined here.
  setupFlows: z
    .record(
      z.string(), // flow name: 'cart' | 'checkout' | 'payment' | 'account' | custom
      z.array(
        z.discriminatedUnion('action', [
          z.object({ action: z.literal('login') }),
          z.object({
            action: z.literal('click'),
            selector: z.string().optional().describe('CSS selector to click'),
            pom: z.string().optional().describe('POM class name, e.g. InventoryPage'),
            field: z.string().optional().describe('Field name on the POM, e.g. firstAddToCartButton'),
          }),
          z.object({
            action: z.literal('navigate'),
            url: z.string().describe('Absolute URL or path to navigate to'),
          }),
        ]),
      ),
    )
    .default({}),
  // Optional app-specific overrides for spec-file naming. The Test Writer agent
  // matches each entry's `pattern` (case-insensitive regex on the test title)
  // against the test case in order. The first match wins. User entries are
  // checked BEFORE the built-in defaults, so they can override or add categories
  // without modifying framework code.
  // Example for a reports app: { pattern: "dashboard|metric|kpi|report", spec: "dashboard" }
  specFileNaming: z
    .array(
      z.object({
        pattern: z
          .string()
          .min(1)
          .describe('Case-insensitive regex matched against the test case title'),
        spec: z
          .string()
          .min(1)
          .regex(/^[a-z0-9-]+$/i, 'spec must be a bare filename without extension or path')
          .describe('Bare spec name without extension, e.g. "dashboard" → tests/generic/dashboard.spec.ts'),
      }),
    )
    .default([]),
  browse: z
    .object({
      baseUrl: z.string().url().describe('Base URL for selector discovery. Locale path appended based on test localeScope.'),
      // Preference order for selector types, highest-priority first. The browse
      // layer uses this to score candidate selectors extracted from the accessibility
      // tree. Unknown tokens are allowed but will simply never match.
      selectorPreference: z
        .array(z.enum(['data-qa', 'data-testid', 'data-test', 'id', 'name', 'type', 'href', 'placeholder', 'aria-label', 'class', 'role', 'text', 'label', 'xpath']))
        .default(['data-qa', 'data-testid', 'data-test', 'id', 'name', 'type', 'href', 'placeholder', 'aria-label']),
      // When true, the Playwright MCP subprocess runs with a visible browser
      // window. Helpful for debugging discovery; off by default for CI.
      headed: z.boolean().default(false),
      email: z.string().optional(),
      password: z.string().optional(),
      maxSnapshotLines: z.number().int().positive().default(150),
    })
    .optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export async function loadConfig(repoRoot: string): Promise<Config> {
  const path = resolve(repoRoot, 'qa-agent.config.json');
  try {
    const raw = await readFile(path, 'utf8');
    return ConfigSchema.parse(JSON.parse(raw));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return ConfigSchema.parse({});
    }
    throw err;
  }
}
