import { validateStatements, StatementParseError } from './validateStatements.js';
export class MethodEditError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = 'MethodEditError';
    }
}
/**
 * Replace the body block of a method with user-supplied statements.
 * Preserves: method name, parameters, async, static, visibility, return type,
 * decorators, overload signatures. Only the { ... } block is swapped.
 *
 * Caller must have already rejected: accessors, abstract methods, constructors,
 * and overloaded methods without an implementation body. findMethod() surfaces
 * those cases so this function can stay narrow.
 */
export function replaceMethodBody(method, newBody) {
    if (method.getBody() === undefined) {
        throw new MethodEditError('no_body', 'method has no body to replace');
    }
    try {
        validateStatements(newBody);
    }
    catch (err) {
        if (err instanceof StatementParseError) {
            throw new MethodEditError('body_parse_failed', `newBody failed to parse: ${err.message}`);
        }
        throw err;
    }
    method.setBodyText(newBody);
}
//# sourceMappingURL=pomMethodEditor.js.map