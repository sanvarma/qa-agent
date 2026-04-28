import { Node, CallExpression } from 'ts-morph';

/**
 * Replace the first argument of the given call expression with a new string literal.
 * Caller is responsible for having validated that:
 *   - the call is one of the supported locator calls
 *   - the first argument is currently a string-like literal
 *
 * This function is intentionally narrow: no call-type rewrites, no second-arg
 * touching. Just swaps the selector string.
 */
export function replaceSelectorStringArg(call: CallExpression, newSelector: string): void {
  const args = call.getArguments();
  if (args.length === 0) {
    throw new Error('call has no arguments');
  }
  const first = args[0];
  if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) {
    throw new Error('first argument is not a string literal');
  }

  // setLiteralValue handles escaping of embedded quotes and preserves the
  // original quote style of the source file (via ts-morph's manipulation settings).
  first.setLiteralValue(newSelector);
}
