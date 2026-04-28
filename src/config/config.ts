import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

export const ConfigSchema = z.object({
  model: z.string().default('unset'),
  maxSteps: z.number().int().positive().default(12),
  maxTokens: z.number().int().positive().default(4096),
  // Validation command is wired here now so the future exec.runTests tool reads from one place.
  validation: z
    .object({
      command: z.string().default('npx playwright test --reporter=json'),
      cwd: z.string().optional(),
    })
    .default({ command: 'npx playwright test --reporter=json' }),
  // Active locales in the target repo. Drives which locale-specific POM and
  // test directories the agent is aware of during generation.
  locales: z.array(z.string()).min(1).default(['en-gb']),
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
  browse: z
    .object({
      appUrl: z.string().url().describe('Base URL the agent navigates to for selector discovery'),
      // Preference order for selector types, highest-priority first. The browse
      // layer uses this to score candidate selectors extracted from the accessibility
      // tree. Unknown tokens are allowed but will simply never match.
      selectorPreference: z
        .array(z.enum(['data-testid', 'id', 'role', 'text', 'label', 'xpath']))
        .default(['data-testid', 'id', 'role', 'text', 'label', 'xpath']),
      // When true, the Playwright MCP subprocess runs with a visible browser
      // window. Helpful for debugging discovery; off by default for CI.
      headed: z.boolean().default(false),
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
