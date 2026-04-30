import { z } from 'zod';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Tool } from '../tool.js';

const Input = z.object({
  key: z.string().min(1).describe("The testData dataset name, e.g. 'users'"),
});
type Input = z.infer<typeof Input>;

interface SchemaResult {
  key: string;
  /** Actual field names present on each record in this dataset. */
  fields: string[];
  /** Number of records available across all data files found. */
  totalRecords: number;
}

async function findJsonFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return results;
  }
  for (const e of entries) {
    const full = join(dir, e);
    const st = await stat(full).catch(() => null);
    if (!st) continue;
    if (st.isDirectory()) {
      results.push(...(await findJsonFiles(full)));
    } else if (e.endsWith('.json')) {
      results.push(full);
    }
  }
  return results;
}

export const testDataGetSchemaTool: Tool<Input, SchemaResult> = {
  name: 'testData.getSchema',
  description:
    "Returns the actual field names for a testData dataset (e.g. 'users'). " +
    'Call this BEFORE writing any test that uses testData so you know the exact field names — never guess them. ' +
    'Scans all data files under src/data/ and returns the field names of the first record found for the given key.',
  inputSchema: Input,
  jsonSchema: {
    type: 'object',
    properties: {
      key: { type: 'string', description: "The testData dataset name, e.g. 'users'" },
    },
    required: ['key'],
    additionalProperties: false,
  },

  async run(input, ctx) {
    const dataRoot = resolve(ctx.repoRoot, 'src', 'data');
    const jsonFiles = await findJsonFiles(dataRoot);

    if (jsonFiles.length === 0) {
      throw new Error(`No data files found under src/data/. Cannot determine schema for key '${input.key}'.`);
    }

    let fields: string[] | null = null;
    let totalRecords = 0;

    for (const filePath of jsonFiles) {
      let parsed: Record<string, unknown[]>;
      try {
        const raw = await readFile(filePath, 'utf8');
        parsed = JSON.parse(raw) as Record<string, unknown[]>;
      } catch {
        continue;
      }

      const records = parsed[input.key];
      if (!Array.isArray(records) || records.length === 0) continue;

      totalRecords += records.length;

      if (fields === null) {
        const first = records[0];
        if (first && typeof first === 'object') {
          fields = Object.keys(first);
        }
      }
    }

    if (fields === null) {
      throw new Error(
        `No records found for key '${input.key}' in any data file under src/data/. ` +
        `Available files: ${jsonFiles.map(f => f.replace(ctx.repoRoot, '')).join(', ')}`,
      );
    }

    return { key: input.key, fields, totalRecords };
  },
};
