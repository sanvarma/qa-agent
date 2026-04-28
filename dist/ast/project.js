import { Project, ScriptTarget, ModuleKind, IndentationText, QuoteKind } from 'ts-morph';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
// One Project per repoRoot. AST tools are usually sequential in this agent
// (the LLM calls them one at a time), so a simple Map cache is sufficient.
// If we ever parallelize, swap for a per-call scoped project — trivial change.
const cache = new Map();
export function getProject(repoRoot) {
    const cached = cache.get(repoRoot);
    if (cached)
        return cached;
    const tsconfigPath = join(repoRoot, 'tsconfig.json');
    const hasTsconfig = existsSync(tsconfigPath);
    // When a tsconfig is present we honor it — the user's module resolution and
    // target should drive how ts-morph parses the file. When it isn't, we fall
    // back to permissive defaults so Playwright JS repos still work.
    const project = hasTsconfig
        ? new Project({
            tsConfigFilePath: tsconfigPath,
            skipAddingFilesFromTsConfig: true, // don't eagerly load entire repo
            manipulationSettings: {
                indentationText: IndentationText.TwoSpaces,
                quoteKind: QuoteKind.Single,
            },
        })
        : new Project({
            compilerOptions: {
                target: ScriptTarget.ES2022,
                module: ModuleKind.ESNext,
                allowJs: true,
            },
            manipulationSettings: {
                indentationText: IndentationText.TwoSpaces,
                quoteKind: QuoteKind.Single,
            },
        });
    cache.set(repoRoot, project);
    return project;
}
/**
 * Drop a file from the project cache. Call after external file changes or
 * between runs to force a fresh parse. Intentionally file-level, not project-level,
 * so we don't pay the full reparse cost on every edit.
 */
export function invalidateSourceFile(repoRoot, absPath) {
    const project = cache.get(repoRoot);
    if (!project)
        return;
    const sf = project.getSourceFile(absPath);
    if (sf)
        project.removeSourceFile(sf);
}
//# sourceMappingURL=project.js.map