import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { getProject, invalidateSourceFile } from '../../ast/project.js';
import { addImport, ImportError } from '../../ast/importEditor.js';
import { unifiedDiff } from '../../ast/diff.js';
const Input = z.object({
    file: z.string().min(1).describe('Path relative to repo root; must resolve under paths.tests or paths.pages'),
    from: z.string().min(1).describe('Module specifier, e.g. "@playwright/test" or "../pages/LoginPage"'),
    named: z.array(z.string()).optional(),
    default: z.string().optional().describe('Default import binding name'),
    typeOnly: z.boolean().optional().default(false),
});
/**
 * This tool can write to either tests/ or pages/ because imports are needed
 * in both flows. We enforce the dual-scope rule inline rather than reusing
 * resolveWithinScope (which takes a single scope).
 */
function resolveInTestsOrPages(filePath, ctx) {
    if (!ctx.paths) {
        throw new Error('ToolContext.paths is required for scope-enforced tools');
    }
    if (isAbsolute(filePath)) {
        throw new Error('path must be relative to repo root');
    }
    const abs = resolve(ctx.repoRoot, filePath);
    const fromRoot = relative(ctx.repoRoot, abs);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) {
        throw new Error('path escapes repo root');
    }
    for (const key of ['tests', 'pages']) {
        const scopeAbs = resolve(ctx.repoRoot, ctx.paths[key]);
        const fromScope = relative(scopeAbs, abs);
        if (fromScope && !fromScope.startsWith('..') && !isAbsolute(fromScope)) {
            return abs;
        }
    }
    throw new Error(`scope violation: '${filePath}' is not under paths.tests ('${ctx.paths.tests}') or paths.pages ('${ctx.paths.pages}')`);
}
export const astAddImportTool = {
    name: 'ast.addImport',
    description: 'Idempotently add named and/or default imports to a TypeScript file under tests/ or pages/. ' +
        'If the module is already imported, merges missing named bindings into the existing declaration. ' +
        'Returns { changed: false } when all requested imports were already present. ' +
        'Refuses if a different default import is already bound to the same module.',
    inputSchema: Input,
    jsonSchema: {
        type: 'object',
        properties: {
            file: { type: 'string' },
            from: { type: 'string' },
            named: { type: 'array', items: { type: 'string' } },
            default: { type: 'string' },
            typeOnly: { type: 'boolean', default: false },
        },
        required: ['file', 'from'],
        additionalProperties: false,
    },
    async run(input, ctx) {
        const absPath = resolveInTestsOrPages(input.file, ctx);
        const beforeSource = await readFile(absPath, 'utf8');
        const project = getProject(ctx.repoRoot);
        invalidateSourceFile(ctx.repoRoot, absPath);
        const sf = project.createSourceFile(absPath, beforeSource, { overwrite: true });
        let result;
        try {
            result = addImport(sf, {
                moduleSpecifier: input.from,
                named: input.named,
                defaultName: input.default,
                typeOnly: input.typeOnly,
            });
        }
        catch (err) {
            if (err instanceof ImportError) {
                throw new Error(`${err.code}: ${err.message}`);
            }
            throw err;
        }
        if (!result.changed) {
            return {
                file: input.file,
                changed: false,
                added: result.added,
                diff: '',
            };
        }
        await sf.save();
        const afterSource = sf.getFullText();
        return {
            file: input.file,
            changed: true,
            added: result.added,
            diff: unifiedDiff(beforeSource, afterSource, input.file),
        };
    },
};
//# sourceMappingURL=addImport.js.map