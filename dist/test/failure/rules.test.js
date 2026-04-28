import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFailure } from '../../src/failure/classify.js';
function failure(overrides) {
    return {
        testTitle: 'some > test',
        file: 'tests/some.spec.js',
        status: 'failed',
        message: '',
        rawSnippet: '',
        ...overrides,
    };
}
describe('failure.classify — selector.not_found', () => {
    test('recognizes "resolved to 0 elements" and extracts locator', async () => {
        const c = await classifyFailure(failure({
            message: "locator.click: Error: strict mode violation: locator('[data-test=btn]') resolved to 0 elements",
            rawSnippet: "locator('[data-test=btn]')",
        }));
        assert.equal(c.kind, 'selector');
        assert.equal(c.action, 'update_pom');
        assert.equal(c.confidence, 0.9);
        assert.equal(c.fixTarget?.locator, '[data-test=btn]');
        assert.equal(c.matchedRule, 'rule.selector.not_found');
    });
    test('"element is not visible" without extractable locator has medium confidence', async () => {
        const c = await classifyFailure(failure({
            message: 'Error: element is not visible',
            rawSnippet: 'some stack with no locator pattern',
        }));
        assert.equal(c.kind, 'selector');
        assert.equal(c.confidence, 0.6);
        assert.equal(c.fixTarget?.locator, undefined);
    });
    test('strict mode violation with multiple matches still classifies as selector', async () => {
        const c = await classifyFailure(failure({
            message: "strict mode violation: locator('.btn') resolved to 3 elements",
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'selector');
        assert.equal(c.matchedRule, 'rule.selector.not_found');
    });
});
describe('failure.classify — selector.timeout', () => {
    test('locator-scoped timeout extracts selector and recommends update_pom', async () => {
        const c = await classifyFailure(failure({
            message: "locator.click: Timeout 30000ms exceeded.",
            rawSnippet: "=> waiting for locator('[data-testid=submit]')",
        }));
        assert.equal(c.kind, 'selector');
        assert.equal(c.action, 'update_pom');
        assert.equal(c.fixTarget?.locator, '[data-testid=submit]');
        assert.equal(c.matchedRule, 'rule.selector.timeout');
    });
    test('locator-scoped timeout without extractable selector still classifies as selector', async () => {
        const c = await classifyFailure(failure({
            message: 'locator.fill: Timeout 5000ms exceeded waiting for locator',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'selector');
        assert.equal(c.confidence, 0.6);
    });
});
describe('failure.classify — navigation', () => {
    test('recognizes net::ERR_ as navigation', async () => {
        const c = await classifyFailure(failure({
            message: 'page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'navigation');
        assert.equal(c.action, 'update_test');
        assert.equal(c.matchedRule, 'rule.navigation');
    });
    test('recognizes toHaveURL timeout as navigation', async () => {
        const c = await classifyFailure(failure({
            message: 'expect(page).toHaveURL(/dashboard/) timed out 5000ms',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'navigation');
        assert.equal(c.matchedRule, 'rule.navigation');
    });
});
describe('failure.classify — assertion', () => {
    test('expect(...).toBe(...) failure classifies as assertion', async () => {
        const c = await classifyFailure(failure({
            message: 'Error: expect(received).toBe(expected) - values differ',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'assertion');
        assert.equal(c.action, 'update_test');
        assert.equal(c.matchedRule, 'rule.assertion');
    });
    test('assertion that is actually a locator timeout does NOT match rule.assertion', async () => {
        // Guard: the assertion rule filters out locator timeouts so the more-specific
        // selector.timeout rule wins. This ordering is load-bearing.
        const c = await classifyFailure(failure({
            message: 'Error: expect(locator).toBeVisible() failed: Timeout 5000ms exceeded',
            rawSnippet: "waiting for locator('[data-test=x]') to be visible",
        }));
        assert.equal(c.kind, 'selector');
        assert.equal(c.matchedRule, 'rule.selector.timeout');
    });
});
describe('failure.classify — app_error', () => {
    test('recognizes 500 response as app-error', async () => {
        const c = await classifyFailure(failure({
            message: 'page received status 500 internal server error',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'app-error');
        assert.equal(c.action, 'retry');
        assert.equal(c.fixTarget, undefined, 'app-error must not suggest a fix target');
    });
    test('recognizes uncaught promise rejection as app-error', async () => {
        const c = await classifyFailure(failure({
            message: 'Uncaught (in promise) TypeError: cannot read property x of undefined',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'app-error');
        assert.equal(c.action, 'retry');
    });
});
describe('failure.classify — timeout.generic (fallback)', () => {
    test('bare timeout with no locator/navigation context falls through to generic', async () => {
        const c = await classifyFailure(failure({
            message: 'Timeout 30000ms exceeded',
            rawSnippet: 'no locator, no navigation signal',
        }));
        assert.equal(c.kind, 'timeout');
        assert.equal(c.action, 'retry');
        assert.equal(c.confidence, 0.3);
        assert.equal(c.matchedRule, 'rule.timeout.generic');
    });
});
describe('failure.classify — unknown fallback', () => {
    test('unrecognized failure returns unknown with retry action', async () => {
        const c = await classifyFailure(failure({
            message: 'some completely novel error shape we have no rule for',
            rawSnippet: '',
        }));
        assert.equal(c.kind, 'unknown');
        assert.equal(c.action, 'retry');
        assert.equal(c.matchedRule, undefined);
    });
    test('unknown fallback with useLlmFallback=true but no provider returns unknown', async () => {
        const c = await classifyFailure(failure({ message: 'totally novel error', rawSnippet: '' }), { useLlmFallback: true });
        assert.equal(c.kind, 'unknown');
        assert.match(c.reasoning, /no LLM classifier was wired/i);
    });
    test('LLM fallback is invoked when configured and returns its classification', async () => {
        const c = await classifyFailure(failure({ message: 'totally novel error', rawSnippet: '' }), {
            useLlmFallback: true,
            llm: {
                async classify() {
                    return {
                        kind: 'unknown',
                        confidence: 0.5,
                        action: 'retry',
                        cause: 'llm-decided',
                        reasoning: 'LLM classified via fallback',
                    };
                },
            },
        });
        assert.equal(c.cause, 'llm-decided');
    });
    test('LLM fallback error is caught and reported in reasoning', async () => {
        const c = await classifyFailure(failure({ message: 'novel', rawSnippet: '' }), {
            useLlmFallback: true,
            llm: {
                async classify() {
                    throw new Error('upstream boom');
                },
            },
        });
        assert.equal(c.kind, 'unknown');
        assert.match(c.reasoning, /upstream boom/);
    });
});
//# sourceMappingURL=rules.test.js.map