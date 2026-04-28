/**
 * Selector preference types understood by the scorer. Matches the enum in
 * Config.browse.selectorPreference.
 *
 * - data-testid : `[data-testid=...]` / Playwright getByTestId
 * - id          : `#foo` / `[id=foo]`
 * - role        : Playwright getByRole('button', { name: ... })
 * - text        : Playwright getByText
 * - label       : Playwright getByLabel
 * - xpath       : `//div[...]`
 *
 * The string literal types here mirror the config enum exactly so there's
 * one source of truth for the taxonomy.
 */
export type SelectorKind = 'data-testid' | 'id' | 'role' | 'text' | 'label' | 'xpath';

export interface SelectorCandidate {
  kind: SelectorKind;
  /**
   * The selector expression as it would appear in Playwright code. For
   * `locator(...)` forms it's the raw selector string; for `getByRole`
   * etc., it's a stable key like "role:button[name='Sign in']" that the
   * caller can translate back into a real call site.
   */
  value: string;
}

export interface ScoredCandidate extends SelectorCandidate {
  /** Position in the preference list; lower is better. */
  rank: number;
}

/**
 * Rank candidates by the configured preference.
 *
 * Candidates with a `kind` not in the preference list are discarded — we
 * don't want to propose an xpath when xpath isn't allowed. If the caller
 * wants "anything as a fallback," they should include the full enum in
 * selectorPreference (which matches our config default).
 */
export function rankCandidates(
  candidates: readonly SelectorCandidate[],
  preference: readonly SelectorKind[],
): ScoredCandidate[] {
  const rankByKind = new Map<SelectorKind, number>();
  preference.forEach((k, i) => rankByKind.set(k, i));

  const scored: ScoredCandidate[] = [];
  for (const c of candidates) {
    const rank = rankByKind.get(c.kind);
    if (rank === undefined) continue;
    scored.push({ ...c, rank });
  }

  // Sort stable by rank asc; keep insertion order for ties so callers
  // that pre-sort by specificity (e.g. most-specific xpath first) keep
  // that ordering within a kind.
  scored.sort((a, b) => a.rank - b.rank);
  return scored;
}

/**
 * Pick the single best candidate from a ranked list, or null if none.
 * Convenience for the common "just give me one" case.
 */
export function bestCandidate(
  candidates: readonly SelectorCandidate[],
  preference: readonly SelectorKind[],
): ScoredCandidate | null {
  const ranked = rankCandidates(candidates, preference);
  return ranked.length > 0 ? ranked[0] : null;
}
