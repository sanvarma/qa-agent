import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import type { Tool } from '../tool.js';

const Input = z.object({});
type Input = z.infer<typeof Input>;

interface PagesStructure {
  /** Files directly under src/pages/<subdir>/ grouped by subdirectory name.
   *  The special key "locales" is itself an object keyed by locale code. */
  [subdir: string]: string[] | Record<string, string[]>;
  locales: Record<string, string[]>;
}

async function listTs(dir: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    const results: string[] = [];
    for (const e of entries) {
      if (e.endsWith('.ts')) results.push(e);
    }
    return results.sort();
  } catch {
    return [];
  }
}

export const pagesGetStructureTool: Tool<Input, PagesStructure> = {
  name: 'pages.getStructure',
  description:
    'Returns the full inventory of page-object files under src/pages/. ' +
    'Use this ONCE at the start of the generate phase to discover which POMs exist and which locales have override folders. ' +
    'The "locales" key maps each locale code to its list of override files. ' +
    'If "locales" is an empty object, no locale overrides exist and companion spec checks can be skipped entirely.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },

  async run(_input, ctx) {
    const pagesRoot = resolve(ctx.repoRoot, 'src', 'pages');

    let topEntries: string[];
    try {
      topEntries = await readdir(pagesRoot);
    } catch {
      return { locales: {} };
    }

    const result: PagesStructure = { locales: {} };

    for (const entry of topEntries) {
      const entryPath = join(pagesRoot, entry);
      const st = await stat(entryPath).catch(() => null);
      if (!st?.isDirectory()) continue;

      if (entry === 'locales') {
        // Two-level: src/pages/locales/<locale>/<Page>.ts
        const localeDirs = await readdir(entryPath).catch(() => [] as string[]);
        for (const locale of localeDirs) {
          const localePath = join(entryPath, locale);
          const lst = await stat(localePath).catch(() => null);
          if (!lst?.isDirectory()) continue;
          const files = await listTs(localePath);
          if (files.length > 0) {
            (result.locales as Record<string, string[]>)[locale] = files;
          }
        }
      } else {
        // e.g. common, base
        const files = await listTs(entryPath);
        if (files.length > 0) {
          (result as Record<string, unknown>)[entry] = files;
        }
      }
    }

    return result;
  },
};
