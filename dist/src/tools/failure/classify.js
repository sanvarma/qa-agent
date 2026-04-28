import { z } from 'zod';
import { classifyFailure } from '../../failure/classify.js';
// Mirror of NormalizedFailure as a zod schema. Kept local so the tool validates
// exactly the shape it documents, independent of any drift in parseReport's internals.
const FailureSchema = z.object({
    testTitle: z.string(),
    file: z.string(),
    line: z.number().int().optional(),
    column: z.number().int().optional(),
    status: z.enum(['failed', 'timedOut', 'interrupted']),
    message: z.string(),
    rawSnippet: z.string(),
});
const Input = z.object({
    failure: FailureSchema,
    // Per the earlier decision: rule-based by default. LLM fallback is explicit.
    // Even when true, this tool returns 'unknown' unless a classifier is wired —
    // wiring is additive and will land when a provider is chosen.
    useLlmFallback: z.boolean().optional().default(false),
});
export const failureClassifyTool = {
    name: 'failure.classify',
    description: 'Classify a single normalized Playwright failure. Returns { kind, confidence (0..1), ' +
        'action (update_pom | update_test | retry), cause, reasoning, fixTarget? }. ' +
        'Kind is one of: selector | timeout | assertion | navigation | app-error | unknown. ' +
        'Rule-based; LLM fallback is off by default.',
    inputSchema: Input,
    jsonSchema: {
        type: 'object',
        properties: {
            failure: {
                type: 'object',
                properties: {
                    testTitle: { type: 'string' },
                    file: { type: 'string' },
                    line: { type: 'integer' },
                    column: { type: 'integer' },
                    status: { type: 'string', enum: ['failed', 'timedOut', 'interrupted'] },
                    message: { type: 'string' },
                    rawSnippet: { type: 'string' },
                },
                required: ['testTitle', 'file', 'status', 'message', 'rawSnippet'],
                additionalProperties: false,
            },
            useLlmFallback: { type: 'boolean', default: false },
        },
        required: ['failure'],
        additionalProperties: false,
    },
    async run(input, _ctx) {
        // No LLM provider wired yet; the classifier handles the "requested but not
        // configured" case by returning 'unknown' with a clear rationale.
        return classifyFailure(input.failure, { useLlmFallback: input.useLlmFallback });
    },
};
//# sourceMappingURL=classify.js.map