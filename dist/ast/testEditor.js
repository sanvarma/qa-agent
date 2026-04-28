import { Node } from 'ts-morph';
import { validateStatements, StatementParseError } from './validateStatements.js';
export class EditError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'EditError';
    }
}
/**
 * Playwright tests take `(title, fn)` — possibly with options:
 *   test("x", async ({ page }) => { ... })
 *   test("x", { tag: "@smoke" }, async ({ page }) => { ... })
 * We pick the LAST argument that is a function — this handles both shapes
 * without hard-coding positions.
 */
function getCallbackArg(call) {
    const args = call.getArguments();
    for (let i = args.length - 1; i >= 0; i--) {
        const a = args[i];
        if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) {
            return a;
        }
    }
    throw new EditError('no_callback', 'test call has no function argument to edit');
}
// -- Body-block replacement -------------------------------------------------
/**
 * Replace the body block of the test's callback with the user-supplied statements.
 * Preserves: title, modifiers (.only/.skip/.fixme), parameters, async-ness, return type.
 * Rejects: expression-bodied arrows (e.g., `() => expr`) — real tests don't use these,
 *          and supporting them would require a broader edit than "replace body".
 */
export function replaceTestBody(call, newBody) {
    const cb = getCallbackArg(call);
    // ArrowFunction may have an expression body — reject. FunctionExpression always has a block.
    if (Node.isArrowFunction(cb)) {
        const body = cb.getBody();
        if (!Node.isBlock(body)) {
            throw new EditError('expression_bodied_arrow', 'callback has an expression body; only block-bodied callbacks are supported');
        }
    }
    // Validate newBody parses as a sequence of statements by wrapping in a scratch function.
    // ts-morph's setBodyText accepts raw text, but does not surface a parse error cleanly —
    // we validate first so failures come back as structured errors, not mid-edit exceptions.
    try {
        validateStatements(newBody);
    }
    catch (err) {
        if (err instanceof StatementParseError) {
            throw new EditError('body_parse_failed', `newBody failed to parse: ${err.message}`);
        }
        throw err;
    }
    // Apply. ts-morph normalizes indentation against the function's context and
    // preserves the surrounding file's formatting.
    if (Node.isArrowFunction(cb) || Node.isFunctionExpression(cb)) {
        cb.setBodyText(newBody);
    }
}
// -- Statement validation ---------------------------------------------------
// Moved to ./validateStatements.ts for reuse by pomMethodEditor.
//# sourceMappingURL=testEditor.js.map