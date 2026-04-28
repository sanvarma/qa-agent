export function findMethod(cls, name) {
    // Accessors are handled by the selector tool, not this one.
    const getter = cls.getGetAccessor(name);
    if (getter)
        return { status: 'is_accessor', kind: 'getter' };
    const setter = cls.getSetAccessor(name);
    if (setter)
        return { status: 'is_accessor', kind: 'setter' };
    // Constructor is reserved for a future tool with different safety semantics.
    if (name === 'constructor')
        return { status: 'is_constructor' };
    // ts-morph unifies overload signatures + implementation under a single
    // MethodDeclaration returned by getMethods(). The overload signatures are
    // accessible via method.getOverloads(). We detect overloading by checking
    // that list, NOT by counting nodes with the same name.
    const matches = cls.getMethods().filter((m) => m.getName() === name);
    if (matches.length === 0) {
        const candidates = cls.getMethods().map((m) => m.getName());
        return { status: 'not_found', methodCandidates: candidates };
    }
    // matches.length is always 1 for well-formed source. Defensive take-first.
    const method = matches[0];
    // Check abstract / body-less BEFORE overloads. ts-morph surfaces a body-less
    // declaration as having an "overload" shape in some cases, so the abstract
    // check must run first. Semantically this is also correct: abstract methods
    // can't have an implementation to overload.
    if (method.isAbstract() || method.getBody() === undefined) {
        return { status: 'abstract' };
    }
    const overloads = method.getOverloads();
    if (overloads.length > 0) {
        // Overloaded. Surface this to the caller so the edit decision is explicit;
        // editing the implementation body alone could invalidate the declared
        // signatures.
        return {
            status: 'overloaded',
            implementationLine: method.getStartLineNumber(),
            signatureLines: overloads.map((o) => o.getStartLineNumber()),
        };
    }
    return {
        status: 'found',
        locator: {
            className: cls.getName(),
            name,
            startLine: method.getStartLineNumber(),
            endLine: method.getEndLineNumber(),
            isAsync: method.isAsync(),
            isStatic: method.isStatic(),
        },
        methodNode: method,
    };
}
//# sourceMappingURL=pomMethodLocator.js.map