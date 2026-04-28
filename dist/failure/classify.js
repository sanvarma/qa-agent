import { rules, CONFIDENCE, kindToAction } from './rules.js';
export async function classifyFailure(failure, opts = {}) {
    const haystack = `${failure.message}\n${failure.rawSnippet}`;
    const ctx = {
        failure,
        haystack,
        haystackLower: haystack.toLowerCase(),
    };
    for (const rule of rules) {
        const hit = rule.match(ctx);
        if (hit)
            return hit;
    }
    // No rule matched. Optionally ask an LLM classifier; otherwise 'unknown'.
    if (opts.useLlmFallback) {
        if (!opts.llm) {
            return {
                kind: 'unknown',
                confidence: CONFIDENCE.LOW,
                action: kindToAction('unknown'),
                cause: 'Unclassified: LLM fallback requested but no classifier configured.',
                reasoning: 'No rule matched the failure signature and LLM fallback was requested, but no LLM classifier was wired. ' +
                    'Retry the test before attempting an edit.',
            };
        }
        try {
            return await opts.llm.classify(failure);
        }
        catch (err) {
            return {
                kind: 'unknown',
                confidence: CONFIDENCE.LOW,
                action: kindToAction('unknown'),
                cause: 'Unclassified: LLM fallback threw an error.',
                reasoning: `LLM fallback failed: ${err instanceof Error ? err.message : String(err)}. Retry the test before attempting an edit.`,
            };
        }
    }
    return {
        kind: 'unknown',
        confidence: CONFIDENCE.LOW,
        action: kindToAction('unknown'),
        cause: 'Unclassified: no rule matched the failure signature.',
        reasoning: 'No rule matched this failure signature. This may be a flake, an uncommon error shape, ' +
            'or a failure mode not yet covered by the rule set. Retry before attempting an edit.',
    };
}
//# sourceMappingURL=classify.js.map