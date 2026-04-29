import type { NormalizedFailure } from '../tools/exec/parseReport.js';
import type { Classification } from '../failure/rules.js';

/**
 * Phases are a strict state machine:
 *
 *   init
 *     └→ generate ─┬→ execute ─┬→ done                    (all tests pass)
 *                  │            └→ analyze ─┬→ fix ─→ execute  (up to maxFixAttempts)
 *                  │                        └→ exhausted    (fix budget used up)
 *                  └→ exhausted                             (generate threw)
 *
 * The orchestrator transitions phases explicitly. The LLM is called only
 * inside generate and fix phases — never to decide transitions.
 */
export type Phase =
  | 'init'
  | 'generate'
  | 'execute'
  | 'analyze'
  | 'fix'
  | 'done'
  | 'exhausted';

export interface AttemptRecord {
  phase: Phase;
  startedAt: string;   // ISO 8601
  endedAt: string;
  ok: boolean;
  detail?: unknown;
}

export interface ExecutionOutcome {
  success: boolean;
  reportPath: string;
  exitCode: number | null;
  durationMs: number;
}

export interface AnalysisOutcome {
  failure: NormalizedFailure;
  classification: Classification;
}

// One entry per fix attempt — passed to each subsequent fix prompt so the
// LLM knows what was tried before and can avoid repeating it.
export interface FixAttempt {
  fixNumber: number;   // 1-based
  failure: NormalizedFailure;
  classification: Classification;
}

export interface OrchestratorState {
  phase: Phase;
  fixAttemptsUsed: number;   // how many fix cycles have run so far

  // Carry-through across phases.
  lastExecution?: ExecutionOutcome;
  lastAnalysis?: AnalysisOutcome;

  // Accumulated fix history — each entry is one failed fix attempt.
  fixHistory: FixAttempt[];

  // Audit trail — append-only.
  attempts: AttemptRecord[];

  readonly runId: string;
  readonly startedAt: string;
}

export interface TransitionOptions {
  detail?: unknown;
  ok?: boolean;
}

export function transition(
  prev: OrchestratorState,
  next: Phase,
  opts: TransitionOptions = {},
): OrchestratorState {
  const now = new Date().toISOString();
  const last = prev.attempts[prev.attempts.length - 1];
  const startedAt = last?.endedAt ?? prev.startedAt;

  const record: AttemptRecord = {
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

export function initialState(runId: string): OrchestratorState {
  return {
    phase: 'init',
    fixAttemptsUsed: 0,
    fixHistory: [],
    attempts: [],
    runId,
    startedAt: new Date().toISOString(),
  };
}
