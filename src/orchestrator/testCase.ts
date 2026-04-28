import { z } from 'zod';
import { readFile } from 'node:fs/promises';

export const TestCaseSchema = z.object({
  title: z.string().min(1).describe('Becomes the test(...) title'),
  describe: z.string().optional().describe('Optional enclosing describe'),
  specFile: z
    .string()
    .optional()
    .describe('Path under paths.tests. Defaults to tests/agent-generated.spec.ts'),
  steps: z.array(z.string().min(1)).min(1).describe('Human-readable steps'),
  expected: z.string().min(1).describe('Expected outcome'),
});

export type TestCase = z.infer<typeof TestCaseSchema>;

export async function loadTestCase(path: string): Promise<TestCase> {
  const raw = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`test case file is not valid JSON: ${(err as Error).message}`);
  }
  const result = TestCaseSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(`test case failed validation: ${result.error.message}`);
  }
  return result.data;
}

/**
 * Render a TestCase as compact human-readable text for embedding into LLM prompts.
 * Deliberately NOT JSON: the LLM reads prompts better when structure is visual.
 */
export function renderTestCase(tc: TestCase): string {
  const lines: string[] = [];
  lines.push(`Title: ${tc.title}`);
  if (tc.describe) lines.push(`Describe: ${tc.describe}`);
  if (tc.specFile) lines.push(`Spec file: ${tc.specFile}`);
  lines.push('Steps:');
  tc.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push(`Expected: ${tc.expected}`);
  return lines.join('\n');
}
