import { resolve, relative, isAbsolute, sep } from 'node:path';
import type { ToolContext } from '../tool.js';

export type ScopeKind = 'tests' | 'pages';

/**
 * Resolve a repo-relative file path and assert it lives under the given scope root.
 * Returns the absolute, resolved path.
 *
 * Throws with a clear message on: absolute input, escape above repoRoot, or scope violation.
 * The registry converts thrown errors into structured { ok: false, error } results.
 */
export function resolveWithinScope(
  filePath: string,
  scope: ScopeKind,
  ctx: ToolContext,
): string {
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

  const scopeRel = ctx.paths[scope];
  const scopeAbs = resolve(ctx.repoRoot, scopeRel);
  const fromScope = relative(scopeAbs, abs);

  // Must be strictly inside the scope root (or equal to it, though that's not a file).
  if (fromScope === '' || fromScope.startsWith('..') || isAbsolute(fromScope)) {
    throw new Error(
      `scope violation: '${filePath}' is not under configured ${scope} root '${scopeRel}'`,
    );
  }
  // Defensive: reject cross-drive or root-escape on Windows-y paths.
  if (fromScope.split(sep).some((seg) => seg === '..')) {
    throw new Error(`scope violation: '${filePath}' escapes ${scope} root`);
  }

  return abs;
}
