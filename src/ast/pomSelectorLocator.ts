import { Node, ClassDeclaration, CallExpression, PropertyDeclaration, Expression } from 'ts-morph';

// -- Recognized locator calls -----------------------------------------------
// Calls where the FIRST argument is a selector string we can safely swap.
// `getByRole` is deliberately excluded: its first arg is a role, not a selector.
const STRING_FIRST_ARG_CALLS = new Set([
  'locator',
  'loc',          // BasePage helper: this.loc(selector) = this.page.locator(selector)
  'getByTestId',
  'getByText',
  'getByLabel',
  'getByPlaceholder',
  'getByAltText',
  'getByTitle',
]);

const ROLE_BASED_CALLS = new Set(['getByRole']);

// -- Public types -----------------------------------------------------------

export type LocatorMethod =
  | 'locator'
  | 'loc'
  | 'getByTestId'
  | 'getByText'
  | 'getByLabel'
  | 'getByPlaceholder'
  | 'getByAltText'
  | 'getByTitle';

export interface SelectorLocator {
  className: string;
  name: string;
  method: LocatorMethod;
  currentSelector: string;
  startLine: number;
  endLine: number;
}

export type FindSelectorResult =
  | { status: 'found'; locator: SelectorLocator; callNode: CallExpression; propertyNode: PropertyDeclaration }
  | { status: 'not_found'; fieldCandidates: string[] }
  | { status: 'not_a_selector_field'; reason: string }
  | { status: 'chained_selectors' }
  | { status: 'role_based_selector' }
  | { status: 'unsupported_call'; callName: string }
  | { status: 'non_string_selector' };

// -- Internal helpers -------------------------------------------------------

/**
 * Returns the unwrapped expression that initializes a field. We do not follow
 * non-parenthesized wrappers — the expected shape is a direct call expression.
 */
function getFieldInitializer(prop: PropertyDeclaration): Expression | undefined {
  return prop.getInitializer();
}

/**
 * Recognize a locator call by its leaf method name, regardless of how it's reached:
 *   this.page.locator(...)       ✓
 *   page.locator(...)            ✓
 *   this._page.getByTestId(...)  ✓
 * We only care about the called method name and its first argument.
 */
function getLeafCallMethodName(call: CallExpression): string | undefined {
  const expr = call.getExpression();
  if (Node.isPropertyAccessExpression(expr)) return expr.getName();
  if (Node.isIdentifier(expr)) return expr.getText();
  return undefined;
}

/**
 * Detect chaining: `.locator('a').locator('b')` — i.e., the call's receiver is
 * itself a locator-producing call. We don't try to guess which link to update;
 * we refuse.
 */
function isChained(call: CallExpression): boolean {
  const expr = call.getExpression();
  if (!Node.isPropertyAccessExpression(expr)) return false;
  const receiver = expr.getExpression();
  if (!Node.isCallExpression(receiver)) return false;
  const receiverMethod = getLeafCallMethodName(receiver);
  if (!receiverMethod) return false;
  return (
    STRING_FIRST_ARG_CALLS.has(receiverMethod) ||
    ROLE_BASED_CALLS.has(receiverMethod)
  );
}

// -- Public API -------------------------------------------------------------

export function findSelectorField(
  cls: ClassDeclaration,
  name: string,
): FindSelectorResult {
  const properties = cls.getProperties();
  const fieldNames = properties.map((p) => p.getName());

  const prop = properties.find((p) => p.getName() === name);
  if (!prop) {
    return { status: 'not_found', fieldCandidates: fieldNames };
  }

  const init = getFieldInitializer(prop);
  if (!init) {
    return {
      status: 'not_a_selector_field',
      reason: 'field has no initializer',
    };
  }
  if (!Node.isCallExpression(init)) {
    return {
      status: 'not_a_selector_field',
      reason: 'field initializer is not a call expression',
    };
  }

  const call = init;
  const method = getLeafCallMethodName(call);
  if (!method) {
    return { status: 'not_a_selector_field', reason: 'could not determine called method' };
  }

  if (ROLE_BASED_CALLS.has(method)) {
    return { status: 'role_based_selector' };
  }
  if (!STRING_FIRST_ARG_CALLS.has(method)) {
    return { status: 'unsupported_call', callName: method };
  }

  if (isChained(call)) {
    return { status: 'chained_selectors' };
  }

  const args = call.getArguments();
  if (args.length === 0) {
    return { status: 'non_string_selector' };
  }
  const first = args[0];
  if (!Node.isStringLiteral(first) && !Node.isNoSubstitutionTemplateLiteral(first)) {
    return { status: 'non_string_selector' };
  }

  return {
    status: 'found',
    locator: {
      className: cls.getName() as string,
      name,
      method: method as LocatorMethod,
      currentSelector: first.getLiteralText(),
      startLine: prop.getStartLineNumber(),
      endLine: prop.getEndLineNumber(),
    },
    callNode: call,
    propertyNode: prop,
  };
}
