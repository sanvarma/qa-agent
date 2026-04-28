import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { initialState, transition, incrementAttempt } from '../../src/orchestrator/state.js';
describe('initialState', () => {
    test('creates a state in phase "init" with zero attempts', () => {
        const s = initialState('run-123', 5);
        assert.equal(s.phase, 'init');
        assert.equal(s.attemptsUsed, 0);
        assert.equal(s.maxAttempts, 5);
        assert.equal(s.runId, 'run-123');
        assert.equal(s.attempts.length, 0);
        assert.match(s.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    });
});
describe('transition', () => {
    test('moves to the new phase and appends an AttemptRecord', () => {
        const s1 = initialState('r', 3);
        const s2 = transition(s1, 'generate');
        assert.equal(s2.phase, 'generate');
        assert.equal(s2.attempts.length, 1);
        assert.equal(s2.attempts[0].phase, 'init', 'record captures the phase being exited');
        assert.equal(s2.attempts[0].ok, true);
    });
    test('does not mutate the previous state', () => {
        const s1 = initialState('r', 3);
        const s2 = transition(s1, 'generate');
        assert.equal(s1.phase, 'init', 'prev.phase unchanged');
        assert.equal(s1.attempts.length, 0, 'prev.attempts unchanged');
        assert.notEqual(s1, s2);
    });
    test('propagates detail and ok=false into the attempt record', () => {
        const s1 = initialState('r', 3);
        const s2 = transition(s1, 'exhausted', { ok: false, detail: { reason: 'x' } });
        const rec = s2.attempts[0];
        assert.equal(rec.ok, false);
        assert.deepEqual(rec.detail, { reason: 'x' });
    });
    test('records derive startedAt from the previous record endedAt (chain property)', () => {
        const s1 = initialState('r', 3);
        const s2 = transition(s1, 'generate');
        const s3 = transition(s2, 'execute');
        // The second record's startedAt must equal the first record's endedAt.
        assert.equal(s3.attempts[1].startedAt, s3.attempts[0].endedAt);
    });
});
describe('incrementAttempt', () => {
    test('increases attemptsUsed by 1 without changing phase', () => {
        const s1 = initialState('r', 3);
        const s2 = incrementAttempt(s1);
        assert.equal(s2.attemptsUsed, 1);
        assert.equal(s2.phase, s1.phase);
        assert.equal(s1.attemptsUsed, 0, 'prev unchanged');
    });
});
//# sourceMappingURL=state.test.js.map