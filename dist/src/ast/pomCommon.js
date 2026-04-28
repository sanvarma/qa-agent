/**
 * Resolve the target class in a POM file.
 *
 * - If `name` is provided, match by exact name. Miss => not_found with candidates.
 * - If `name` is omitted, require exactly one class in the file:
 *     0 classes -> no_class
 *     1 class   -> found
 *     2+        -> ambiguous with candidates (LLM must retry with name)
 *
 * Anonymous class expressions are ignored — POM convention is always a named class.
 */
export function resolveClass(sf, name) {
    const classes = sf.getClasses().filter((c) => !!c.getName());
    const names = classes.map((c) => c.getName());
    if (name) {
        const match = classes.find((c) => c.getName() === name);
        if (match)
            return { status: 'found', cls: match };
        return { status: 'not_found', candidates: names };
    }
    if (classes.length === 0)
        return { status: 'no_class' };
    if (classes.length === 1)
        return { status: 'found', cls: classes[0] };
    return { status: 'ambiguous', candidates: names };
}
//# sourceMappingURL=pomCommon.js.map