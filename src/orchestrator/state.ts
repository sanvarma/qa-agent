import type { NormalizedFailure } from '../tools/exec/parseReport.js';
import type { Classification } from '../failure/rules.js';

/**
 * Phases are a strict state machine:
 *
 *   init
 *     └→ generate ──┬→ execute ─┬→ done                              (all tests pass)
 *                   │            └→ analyze ─┬→ fix ──→ execute       (fix loop)
 *                   │                        ├→ regenerate ─→ execute (escape hatch after N failed fixes)
 *                   │                        └→ exhausted             (budget or un-actionable)
 *                   └→ exhausted                                      (generate threw)
 *
 * The orchestrator transitions phases explicitly. The LLM is called only
 * inside generate, fix, and regenerate phases — never to decide transitions.
 */
export type Phase =
  | 'init'
  | 'generate'
  | 'execute'
  | 'analyze'
  | 'fix'
  | 'regenerate'
  | 'done'
  | 'exhausted';

export interface AttemptRecord {
  attemptNumber: number;        // 1-based
  phase: Phase;                 // which phase produced this record
  startedAt: string;            // ISO 8601
  endedAt: string;
  ok: boolean;
  // Phase-specific payload — opaque to the orchestrator, readable by the logger.
  detail?: unknown;
}

export interface ExecutionOutcome {
  success: boolean;
  reportPath: string;
  exitCode: number | null;
  durationMs: number;
}

export interface AnalysisOutcome {
  // We only classify the first failure per attempt. Multiple-failure fan-out
  // is deferred — it adds surface area without clarifying the common case.
  failure: NormalizedFailure;
  classification: Classification;
}

// One entry per fix attempt — records what was wrong and how the agent tried to fix it.
// The subsequent failure (if any) is recorded in the NEXT entry, giving the LLM a
// before/after view of what it tried and whether it helped.
export interface FixAttempt {
  attemptNumber: number;
  failure: NormalizedFailure;
  classification: Classification;
}

export interface OrchestratorState {
  phase: Phase;
  attemptsUsed: number;
  maxAttempts: number;

  // Carry-through across phases.
  lastExecution?: ExecutionOutcome;
  lastAnalysis?: AnalysisOutcome;

  // Self-healing tracking.
  // Every fix attempt in order — passed to the fix prompt so the LLM
  // knows what was already tried and can avoid repeating it.
  fixHistory: FixAttempt[];
  // Resets to 0 on a successful execute or after a regenerate.
  // When it reaches cfg.maxConsecutiveFixFailures the orchestrator
  // switches to the regenerate phase instead of another fix.
  consecutiveFixFailures: number;

  // Audit trail — append-only. Persisted alongside run.json.
  attempts: AttemptRecord[];

  // Immutable run-identity fields.
  readonly runId: string;
  readonly startedAt: string;
}

export interface TransitionOptions {
  detail?: unknown;
  ok?: boolean;
}

/**
 * Transition the state to a new phase, appending an AttemptRecord for the
 * phase being exited. Returns a new state object — callers should replace
 * their reference. This is mutation-via-replacement to keep the attempt
 * history auditable.
 */
export function transition(
  prev: OrchestratorState,
  next: Phase,
  opts: TransitionOptions = {},
): OrchestratorState {
  const now = new Date().toISOString();
  const last = prev.attempts[prev.attempts.length - 1];
  const startedAt = last?.endedAt ?? prev.startedAt;

  const record: AttemptRecord = {
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
export function incrementAttempt(state: OrchestratorState): OrchestratorState {
  return { ...state, attemptsUsed: state.attemptsUsed + 1 };
}

export function initialState(
  runId: string,
  maxAttempts: number,
): OrchestratorState {
  return {
    phase: 'init',
    attemptsUsed: 0,
    maxAttempts,
    fixHistory: [],
    consecutiveFixFailures: 0,
    attempts: [],
    runId,
    startedAt: new Date().toISOString(),
  };
}
