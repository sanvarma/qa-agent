/**
 * Transition the state to a new phase, appending an AttemptRecord for the
 * phase being exited. Returns a new state object — callers should replace
 * their reference. This is mutation-via-replacement to keep the attempt
 * history auditable.
 */
export function transition(prev, next, opts = {}) {
    const now = new Date().toISOString();
    const last = prev.attempts[prev.attempts.length - 1];
    const startedAt = last?.endedAt ?? prev.startedAt;
    const record = {
        attemptNumber: prev.attemptsUsed,
        phase: prev.phase,
        startedAt,
        endedAt: now,
        ok: opts.ok ?? true,
        detail: opts.detail,
    };
    return {
        ...prev,
        phase: next,
        attempts: [...prev.attempts, record],
    };
}
/**
 * Count a new attempt. An "attempt" is one full generate-or-fix cycle —
 * the orchestrator increments this when entering `generate` or `fix`.
 * Used as the retry budget.
 */
export function incrementAttempt(state) {
    return { ...state, attemptsUsed: state.attemptsUsed + 1 };
}
export function initialState(runId, maxAttempts) {
    return {
        phase: 'init',
        attemptsUsed: 0,
        maxAttempts,
        attempts: [],
        runId,
        startedAt: new Date().toISOString(),
    };
}
//# sourceMappingURL=state.js.map