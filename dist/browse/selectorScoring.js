/**
 * Rank candidates by the configured preference.
 *
 * Candidates with a `kind` not in the preference list are discarded — we
 * don't want to propose an xpath when xpath isn't allowed. If the caller
 * wants "anything as a fallback," they should include the full enum in
 * selectorPreference (which matches our config default).
 */
export function rankCandidates(candidates, preference) {
    const rankByKind = new Map();
    preference.forEach((k, i) => rankByKind.set(k, i));
    const scored = [];
    for (const c of candidates) {
        const rank = rankByKind.get(c.kind);
        if (rank === undefined)
            continue;
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
export function bestCandidate(candidates, preference) {
    const ranked = rankCandidates(candidates, preference);
    return ranked.length > 0 ? ranked[0] : null;
}
//# sourceMappingURL=selectorScoring.js.map