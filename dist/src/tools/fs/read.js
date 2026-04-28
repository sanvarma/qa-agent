import { z } from 'zod';
import { readFile, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
const MAX_BYTES = 256 * 1024; // 256KB hard cap per read; keeps context bounded
const Input = z.object({
    path: z.string().min(1).describe('Path relative to repo root'),
    startLine: z.number().int().min(1).optional(),
    endLine: z.number().int().min(1).optional(),
});
export const fsReadTool = {
    name: 'fs.read',
    description: 'Read a UTF-8 text file from the target repo. Path must be relative to repo root. ' +
        'Optionally returns a line range. Output is capped; for large files, request a range.',
    inputSchema: Input,
    jsonSchema: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path relative to repo root' },
            startLine: { type: 'integer', minimum: 1 },
            endLine: { type: 'integer', minimum: 1 },
        },
        required: ['path'],
        additionalProperties: false,
    },
    async run(input, ctx) {
        if (isAbsolute(input.path)) {
            throw new Error('path must be relative to repo root');
        }
        const abs = resolve(ctx.repoRoot, input.path);
        const rel = relative(ctx.repoRoot, abs);
        if (rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error('path escapes repo root');
        }
        const st = await stat(abs);
        if (!st.isFile())
            throw new Error('not a regular file');
        if (st.size > MAX_BYTES * 8) {
            // refuse obviously-huge files outright; caller should narrow
            throw new Error(`file too large (${st.size} bytes); request a line range`);
        }
        const raw = await readFile(abs, 'utf8');
        const lines = raw.split('\n');
        const total = lines.length;
        const start = input.startLine ?? 1;
        const end = Math.min(input.endLine ?? total, total);
        if (start > end)
            throw new Error('startLine > endLine');
        let slice = lines.slice(start - 1, end).join('\n');
        let truncated = false;
        if (slice.length > MAX_BYTES) {
            slice = slice.slice(0, MAX_BYTES);
            truncated = true;
        }
        return {
            path: input.path,
            totalLines: total,
            startLine: start,
            endLine: end,
            truncated,
            content: slice,
        };
    },
};
//# sourceMappingURL=read.js.map