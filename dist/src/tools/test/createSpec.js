import { z } from 'zod';
import { writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { resolveWithinScope } from '../util/scope.js';
import { invalidateSourceFile } from '../../ast/project.js';
import { scaffoldSpec } from '../../ast/specScaffolder.js';
const Input = z.object({
    file: z.string().min(1).describe('Path relative to repo root; must resolve under paths.tests'),
    describe: z.string().optional().describe('Optional top-level describe to include in the scaffold'),
});
export const testCreateSpecTool = {
    name: 'test.createSpec',
    description: 'Scaffold a new, empty Playwright spec file at the given path under the tests scope. ' +
        'Refuses if the file already exists — use test.addCase to add tests to an existing spec. ' +
        'Produces the minimal shape: one Playwright import and (optionally) an empty describe block.',
    inputSchema: Input,
    jsonSchema: {
        type: 'object',
        properties: {
            file: { type: 'string' },
            describe: { type: 'string' },
        },
        required: ['file'],
        additionalProperties: false,
    },
    async run(input, ctx) {
        const absPath = resolveWithinScope(input.file, 'tests', ctx);
        if (existsSync(absPath)) {
            throw new Error(`spec file already exists: ${input.file}. Use test.addCase to add tests to it.`);
        }
        const contents = scaffoldSpec({ describe: input.describe });
        // Ensure parent directory exists. The scope helper already guarantees
        // we're under paths.tests, so this mkdir is safe.
        await mkdir(dirname(absPath), { recursive: true });
        await writeFile(absPath, contents, 'utf8');
        // Drop any stale project cache entry. Matches the pattern used by editCase
        // so a subsequent test.addCase reparses fresh.
        invalidateSourceFile(ctx.repoRoot, absPath);
        return {
            file: input.file,
            bytesWritten: Buffer.byteLength(contents, 'utf8'),
            contents,
        };
    },
};
//# sourceMappingURL=createSpec.js.map