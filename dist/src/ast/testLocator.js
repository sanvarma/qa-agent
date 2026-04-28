import { Node } from 'ts-morph';
function classifyCall(call) {
    const expr = call.getExpression();
    // Chained call: test.each([...])(title, fn) — the outer call's receiver is
    // the inner `test.each([...])` invocation. Unwrap once and check that inner
    // call is `test.each` / `it.each`.
    if (Node.isCallExpression(expr)) {
        const innerExpr = expr.getExpression();
        if (Node.isPropertyAccessExpression(innerExpr)) {
            const innerObj = innerExpr.getExpression();
            const innerProp = innerExpr.getName();
            if (innerProp === 'each' &&
                Node.isIdentifier(innerObj) &&
                (innerObj.getText() === 'test' || innerObj.getText() === 'it')) {
                return {
                    role: 'test',
                    name: innerObj.getText(),
                    isEach: true,
                };
            }
        }
        return null;
    }
    // Plain identifier: test(...), it(...), describe(...)
    if (Node.isIdentifier(expr)) {
        const name = expr.getText();
        if (name === 'test' || name === 'it') {
            return { role: 'test', name, isEach: false };
        }
        if (name === 'describe') {
            return { role: 'describe' };
        }
        return null;
    }
    // Property access: test.only(...), test.each(...), test.describe(...)
    if (Node.isPropertyAccessExpression(expr)) {
        const obj = expr.getExpression();
        const prop = expr.getName();
        // Nested forms like test.describe.only(...) — unwrap one level.
        if (Node.isPropertyAccessExpression(obj)) {
            const outerObj = obj.getExpression();
            const outerProp = obj.getName();
            if (Node.isIdentifier(outerObj) &&
                outerObj.getText() === 'test' &&
                outerProp === 'describe' &&
                (prop === 'only' || prop === 'skip')) {
                return { role: 'describe', modifier: prop };
            }
            return null;
        }
        if (!Node.isIdentifier(obj))
            return null;
        const base = obj.getText();
        if (base === 'test' || base === 'it') {
            if (prop === 'describe')
                return { role: 'describe' };
            if (prop === 'only' || prop === 'skip' || prop === 'fixme') {
                return { role: 'test', name: base, modifier: prop, isEach: false };
            }
            // Note: `test.each(...)` as a bare property-access call is just the
            // inner "array" call — it returns a function. The user-facing test call
            // is `test.each([...])(title, fn)`, handled by the chained-call branch
            // above. We intentionally return null here so walker behavior stays clean.
            return null;
        }
        if (base === 'describe') {
            if (prop === 'only' || prop === 'skip')
                return { role: 'describe', modifier: prop };
            return null;
        }
    }
    return null;
}
// -- Title extraction --------------------------------------------------------
/**
 * Extract a string literal title from the first argument of a test/describe call.
 * Returns undefined for non-literal titles (template with interpolation, variable, etc.)
 * — those are valid code but we can't match them by user-supplied title string,
 * so they're invisible to this locator by design.
 */
function extractLiteralTitle(call) {
    const [first] = call.getArguments();
    if (!first)
        return undefined;
    if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
        return first.getLiteralText();
    }
    return undefined;
}
function describePathMatches(actual, want) {
    if (!want)
        return true;
    if (actual.length !== want.length)
        return false;
    for (let i = 0; i < want.length; i++) {
        if (actual[i] !== want[i])
            return false;
    }
    return true;
}
function walk(node, state) {
    if (Node.isCallExpression(node)) {
        const kind = classifyCall(node);
        if (kind) {
            const title = extractLiteralTitle(node);
            if (title !== undefined) {
                if (kind.role === 'describe') {
                    // Descend into the describe's callback with an extended path.
                    // We walk children normally; the describe's inner calls will see the
                    // extended describePath via the stack push/pop below.
                    state.describePath.push(title);
                    for (const child of node.getChildren())
                        walk(child, state);
                    state.describePath.pop();
                    return; // already walked children
                }
                if (kind.role === 'test') {
                    const candidate = {
                        describePath: [...state.describePath],
                        title,
                        startLine: node.getStartLineNumber(),
                        endLine: node.getEndLineNumber(),
                        kind: kind.name,
                        modifier: kind.modifier,
                        isEach: kind.isEach,
                    };
                    state.candidates.push(candidate);
                    if (title === state.wantTitle && describePathMatches(candidate.describePath, state.wantDescribePath)) {
                        state.matches.push({
                            locator: {
                                describePath: candidate.describePath,
                                title: candidate.title,
                                startLine: candidate.startLine,
                                endLine: candidate.endLine,
                                kind: candidate.kind,
                                modifier: candidate.modifier,
                                isEach: candidate.isEach,
                            },
                            node,
                        });
                    }
                    // fall through to walk children — nested tests are invalid but we don't assume
                }
            }
        }
    }
    for (const child of node.getChildren())
        walk(child, state);
}
export function findTestCase(sf, args) {
    const state = {
        describePath: [],
        candidates: [],
        matches: [],
        wantTitle: args.title,
        wantDescribePath: args.describePath,
    };
    walk(sf, state);
    if (state.matches.length === 1) {
        const { locator, node } = state.matches[0];
        return {
            status: 'found',
            locator: { file: args.fileLabel, ...locator },
            node,
        };
    }
    if (state.matches.length === 0) {
        return { status: 'not_found', candidates: state.candidates };
    }
    return {
        status: 'ambiguous',
        candidates: state.matches.map((m) => m.locator),
    };
}
//# sourceMappingURL=testLocator.js.map