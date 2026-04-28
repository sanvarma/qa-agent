export const CONFIDENCE = {
    HIGH: 0.9,
    MEDIUM: 0.6,
    LOW: 0.3,
};
/**
 * Deterministic map from classified kind to suggested action.
 * Kept as a single source of truth so all rules stay consistent.
 */
export function kindToAction(kind) {
    switch (kind) {
        case 'selector':
            return 'update_pom';
        case 'assertion':
        case 'navigation':
            return 'update_test';
        case 'timeout':
        case 'app-error':
        case 'unknown':
            return 'retry';
    }
}
// -- helpers -----------------------------------------------------------------
// Playwright's "locator resolved to" / "waiting for locator" patterns expose
// the selector string literally. We extract the first occurrence.
// Examples this handles:
//   "locator.click: Timeout 30000ms exceeded.\n=> waiting for locator('[data-test=dashboard]')"
//   "Error: expect(locator).toBeVisible() failed\nLocator: locator('button:has-text(\"Login\")')"
const LOCATOR_PATTERNS = [
    /locator\((['"`])(.+?)\1\)/, // locator('...')
    /waiting for (?:locator|selector)\s+(['"`])(.+?)\1/i,
    /Locator:\s+(['"`])(.+?)\1/i,
    /selector\s+(['"`])(.+?)\1/i,
];
function extractLocator(haystack) {
    for (const re of LOCATOR_PATTERNS) {
        const m = haystack.match(re);
        if (m && m[2])
            return m[2];
    }
    return undefined;
}
function baseTarget(f, locator) {
    return { file: f.file, locator };
}
// -- rules -------------------------------------------------------------------
// Order matters: first match wins. More specific rules go first.
export const rules = [
    // Selector not found / not visible — the classic "element missing" failure.
    // This is specifically about *the element not existing or not being visible*,
    // which points at the POM selector.
    {
        id: 'rule.selector.not_found',
        match({ haystackLower, haystack, failure }) {
            const selectorSignals = /\b(element is not attached|element is not visible|resolved to 0 elements|no element matches selector|strict mode violation: .* resolved to \d+ elements)\b/;
            if (!selectorSignals.test(haystackLower))
                return null;
            const locator = extractLocator(haystack);
            return {
                kind: 'selector',
                confidence: locator ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
                action: kindToAction('selector'),
                cause: locator
                    ? `Selector '${locator}' did not resolve to a usable element.`
                    : 'A locator did not resolve to a usable element.',
                reasoning: locator
                    ? `Selector '${locator}' did not resolve to a usable element. The page-object's selector is likely stale or wrong for the current UI.`
                    : 'A locator did not resolve to a usable element; selector appears outdated.',
                fixTarget: baseTarget(failure, locator),
                matchedRule: 'rule.selector.not_found',
            };
        },
    },
    // Locator-scoped timeout — waiting for an element that never appeared.
    // Distinct from a generic action timeout; this one blames the selector.
    {
        id: 'rule.selector.timeout',
        match({ haystackLower, haystack, failure }) {
            const isTimeout = /timeout\s+\d+\s*ms\s+exceeded|timed out \d+\s*ms waiting/.test(haystackLower);
            const isLocatorScoped = /waiting for (locator|selector)|locator\.(click|fill|waitfor|istype|type|check|hover)/.test(haystackLower);
            if (!(isTimeout && isLocatorScoped))
                return null;
            const locator = extractLocator(haystack);
            return {
                kind: 'selector',
                confidence: locator ? CONFIDENCE.HIGH : CONFIDENCE.MEDIUM,
                action: kindToAction('selector'),
                cause: locator
                    ? `Timed out waiting for locator '${locator}'.`
                    : 'Timed out waiting for a locator.',
                reasoning: locator
                    ? `Timed out waiting for locator '${locator}' — likely a stale or wrong selector in the page object.`
                    : 'Timed out waiting for a locator — likely a stale or wrong selector in the page object.',
                fixTarget: baseTarget(failure, locator),
                matchedRule: 'rule.selector.timeout',
            };
        },
    },
    // Navigation / network — URL didn't change, page didn't load, net::ERR_*.
    // Fix target is usually the test flow itself, not the POM selector.
    {
        id: 'rule.navigation',
        match({ haystackLower, failure }) {
            const nav = /net::err_|failed to navigate|page\.goto:|expected url|tohaveurl.*timed out|exceeded while waiting for event "load"/.test(haystackLower);
            if (!nav)
                return null;
            return {
                kind: 'navigation',
                confidence: CONFIDENCE.MEDIUM,
                action: kindToAction('navigation'),
                cause: 'Navigation or page load did not reach the expected state.',
                reasoning: 'The test expected a navigation, URL change, or page load that did not happen. ' +
                    'Most often this reflects an incorrect URL expectation or a missing wait in the test flow.',
                fixTarget: { file: failure.file },
                matchedRule: 'rule.navigation',
            };
        },
    },
    // Assertion — expect(...).toXxx failures that aren't locator-timeouts.
    // Usually points to the spec's expectations, not the POM.
    {
        id: 'rule.assertion',
        match({ haystackLower, failure }) {
            const isExpect = /^error:\s+expect|expect\([^)]*\)\.\w+/m.test(haystackLower);
            const isLocatorTimeout = /waiting for (locator|selector)/.test(haystackLower);
            if (!isExpect || isLocatorTimeout)
                return null;
            return {
                kind: 'assertion',
                confidence: CONFIDENCE.MEDIUM,
                action: kindToAction('assertion'),
                cause: 'Assertion failed on observed vs expected value.',
                reasoning: 'An expect(...) assertion failed and the failure was not a locator timeout. ' +
                    'The test\'s expectation is likely outdated for the current application behavior.',
                fixTarget: { file: failure.file },
                matchedRule: 'rule.assertion',
            };
        },
    },
    // App-side error surfaced through the page (uncaught exception, 500, console error).
    // No POM/test fix applies — the agent should report, not auto-fix.
    {
        id: 'rule.app_error',
        match({ haystackLower }) {
            const appSignals = /uncaught \(in promise\)|page crashed|status 5\d\d|internal server error|console error|unhandledrejection/.test(haystackLower);
            if (!appSignals)
                return null;
            return {
                kind: 'app-error',
                confidence: CONFIDENCE.MEDIUM,
                action: kindToAction('app-error'),
                cause: 'Failure originates in the application under test.',
                reasoning: 'The failure signature points at an app-side error (uncaught exception, 5xx response, ' +
                    'console error, or similar). Test and page-object code are not at fault; the agent ' +
                    'should not attempt an auto-fix — retry and report.',
                // No fixTarget — this is not something the agent should edit.
                matchedRule: 'rule.app_error',
            };
        },
    },
    // Generic timeout fallback — timed out, but we couldn't pin it to a locator
    // or navigation. Lower confidence than the locator-scoped rule above.
    {
        id: 'rule.timeout.generic',
        match({ haystackLower, failure }) {
            if (!/timeout|timed out/.test(haystackLower))
                return null;
            return {
                kind: 'timeout',
                confidence: CONFIDENCE.LOW,
                action: kindToAction('timeout'),
                cause: 'A timeout occurred; specific cause could not be determined.',
                reasoning: 'The failure mentioned a timeout but did not match a locator-scoped or navigation-scoped pattern. ' +
                    'Could be flake, environmental slowness, or an unclassified issue — retry before editing code.',
                fixTarget: { file: failure.file },
                matchedRule: 'rule.timeout.generic',
            };
        },
    },
];
//# sourceMappingURL=rules.js.map