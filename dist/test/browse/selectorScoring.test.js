import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { rankCandidates, bestCandidate } from '../../src/browse/selectorScoring.js';
describe('rankCandidates', () => {
    test('orders candidates by preference, lowest rank first', () => {
        const candidates = [
            { kind: 'xpath', value: '//div' },
            { kind: 'data-testid', value: 'submit' },
            { kind: 'id', value: 'btn' },
        ];
        const ranked = rankCandidates(candidates, ['data-testid', 'id', 'xpath']);
        assert.equal(ranked.length, 3);
        assert.equal(ranked[0].kind, 'data-testid');
        assert.equal(ranked[1].kind, 'id');
        assert.equal(ranked[2].kind, 'xpath');
    });
    test('filters out candidates whose kind is not in the preference list', () => {
        const candidates = [
            { kind: 'xpath', value: '//div' },
            { kind: 'data-testid', value: 'submit' },
        ];
        const ranked = rankCandidates(candidates, ['data-testid']); // xpath excluded
        assert.equal(ranked.length, 1);
        assert.equal(ranked[0].kind, 'data-testid');
    });
    test('is stable within a kind (preserves input order for ties)', () => {
        const candidates = [
            { kind: 'data-testid', value: 'a' },
            { kind: 'data-testid', value: 'b' },
        ];
        const ranked = rankCandidates(candidates, ['data-testid']);
        assert.equal(ranked[0].value, 'a');
        assert.equal(ranked[1].value, 'b');
    });
    test('returns empty when no candidates match preference', () => {
        const candidates = [{ kind: 'xpath', value: '//x' }];
        const ranked = rankCandidates(candidates, ['data-testid', 'id']);
        assert.deepEqual(ranked, []);
    });
});
describe('bestCandidate', () => {
    test('returns the highest-ranked candidate', () => {
        const candidates = [
            { kind: 'xpath', value: '//div' },
            { kind: 'data-testid', value: 'x' },
        ];
        const best = bestCandidate(candidates, ['data-testid', 'xpath']);
        assert.notEqual(best, null);
        assert.equal(best.kind, 'data-testid');
    });
    test('returns null when nothing matches', () => {
        const best = bestCandidate([{ kind: 'xpath', value: '//x' }], ['data-testid']);
        assert.equal(best, null);
    });
});
//# sourceMappingURL=selectorScoring.test.js.map