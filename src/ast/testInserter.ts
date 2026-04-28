import { Node, SourceFile, CallExpression, Block } from 'ts-morph';

// -- Errors -----------------------------------------------------------------

export type InsertErrorCode =
  | 'describe_not_found'
  | 'describe_ambiguous'
  | 'duplicate_title'
  | 'describe_body_not_block';

export class InsertError extends Error {
  constructor(public code: InsertErrorCode, message: string) {
    super(message);
    this.name = 'InsertError';
  }
}

// -- Public types -----------------------------------------------------------

export interface InsertArgs {
  title: string;
  describe?: string;       // if provided, must exist as a top-level describe in the file
  body: string;            // raw statements for the test callback body (no braces)
  position: 'start' | 'end';
}

export interface InsertResult {
  startLine: number;       // 1-based, inclusive
  endLine: number;
}

// -- Call classification (duplicate check scope) ----------------------------

type CallKind = 'test' | 'describe' | null;

function classifyTopLevelCall(call: CallExpression): { kind: CallKind; title?: string } {
  const expr = call.getExpression();

  // Identifier: test(), it(), describe()
  let name: string | undefined;
  if (Node.isIdentifier(expr)) {
    name = expr.getText();
  } else if (Node.isPropertyAccessExpression(expr)) {
    // Property access: test.only, test.skip, test.describe, test.describe.only, etc.
    const obj = expr.getExpression();
    const prop = expr.getName();

    // Two-level: test.describe.only, test.describe.skip
    if (Node.isPropertyAccessExpression(obj)) {
      const outer = obj.getExpression();
      const outerProp = obj.getName();
      if (Node.isIdentifier(outer) && outer.getText() === 'test' && outerProp === 'describe') {
        name = 'describe';
      }
    } else if (Node.isIdentifier(obj)) {
      const base = obj.getText();
      if (base === 'test' || base === 'it') {
        if (prop === 'describe') name = 'describe';
        else if (prop === 'only' || prop === 'skip' || prop === 'fixme') name = base;
      } else if (base === 'describe') {
        if (prop === 'only' || prop === 'skip') name = 'describe';
      }
    }
  }

  if (name === 'test' || name === 'it') {
    const title = extractLiteralTitle(call);
    return { kind: 'test', title };
  }
  if (name === 'describe') {
    const title = extractLiteralTitle(call);
    return { kind: 'describe', title };
  }
  return { kind: null };
}

function extractLiteralTitle(call: CallExpression): string | undefined {
  const first = call.getArguments()[0];
  if (!first) return undefined;
  if (Node.isStringLiteral(first) || Node.isNoSubstitutionTemplateLiteral(first)) {
    return first.getLiteralText();
  }
  return undefined;
}

// -- Describe resolution ----------------------------------------------------

interface DescribeMatch {
  call: CallExpression;
  block: Block;
}

/**
 * Find a top-level (not nested) describe by exact title. Playwright test files
 * typically have describes at module scope; we don't search deeper to avoid
 * ambiguity with nested describes that happen to share a title.
 */
function findTopLevelDescribe(sf: SourceFile, title: string): DescribeMatch[] {
  const matches: DescribeMatch[] = [];
  for (const stmt of sf.getStatements()) {
    if (!Node.isExpressionStatement(stmt)) continue;
    const expr = stmt.getExpression();
    if (!Node.isCallExpression(expr)) continue;

    const { kind, title: t } = classifyTopLevelCall(expr);
    if (kind !== 'describe' || t !== title) continue;

    // Find the callback block. describe("x", () => { ... }) — last function arg.
    const args = expr.getArguments();
    for (let i = args.length - 1; i >= 0; i--) {
      const a = args[i];
      if (Node.isArrowFunction(a) || Node.isFunctionExpression(a)) {
        const body = a.getBody();
        if (!Node.isBlock(body)) {
          throw new InsertError(
            'describe_body_not_block',
            `describe('${title}') has a non-block body`,
          );
        }
        matches.push({ call: expr, block: body });
        break;
      }
    }
  }
  return matches;
}

// -- Duplicate detection within a scope -------------------------------------

/**
 * Collect test titles whose test(...) call lives directly inside the given scope.
 * We only look one level deep — a test nested inside a describe inside our scope
 * is not a duplicate for our purposes.
 */
function collectDirectTestTitles(scope: SourceFile | Block): Map<string, number> {
  const titles = new Map<string, number>();
  const statements = scope.getStatements();

  for (const stmt of statements) {
    if (!Node.isExpressionStatement(stmt)) continue;
    const expr = stmt.getExpression();
    if (!Node.isCallExpression(expr)) continue;

    const { kind, title } = classifyTopLevelCall(expr);
    if (kind === 'test' && title !== undefined) {
      titles.set(title, stmt.getStartLineNumber());
    }
  }
  return titles;
}

// -- Test text generation ---------------------------------------------------

/**
 * Produce the exact source text of a new test(...) statement.
 * Uses two-space indentation of the body; ts-morph's setBodyText would
 * normalize context indentation, but here we emit raw text that gets inserted
 * as a complete statement — so we format it ourselves, consistently.
 *
 * Body lines keep their existing indentation (caller supplies).
 */
function renderTestStatement(title: string, body: string): string {
  // Escape single quotes and backslashes in the title so we can use single quotes.
  const safeTitle = title.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

  // If body is empty or whitespace-only, still emit a valid block.
  const bodyTrimmed = body.replace(/\s+$/, '');
  const indentedBody = bodyTrimmed
    ? bodyTrimmed
        .split('\n')
        .map((line) => (line.length === 0 ? '' : '  ' + line))
        .join('\n') + '\n'
    : '';

  return `test('${safeTitle}', async ({ page }) => {\n${indentedBody}});`;
}

// -- Public API -------------------------------------------------------------

export function insertTestCase(sf: SourceFile, args: InsertArgs): InsertResult {
  // Resolve target scope.
  let scope: SourceFile | Block;
  if (args.describe) {
    const describes = findTopLevelDescribe(sf, args.describe);
    if (describes.length === 0) {
      throw new InsertError(
        'describe_not_found',
        `top-level describe '${args.describe}' not found in file`,
      );
    }
    if (describes.length > 1) {
      throw new InsertError(
        'describe_ambiguous',
        `multiple top-level describes with title '${args.describe}' — cannot disambiguate`,
      );
    }
    scope = describes[0].block;
  } else {
    scope = sf;
  }

  // Duplicate detection within scope.
  const existing = collectDirectTestTitles(scope);
  if (existing.has(args.title)) {
    throw new InsertError(
      'duplicate_title',
      `test '${args.title}' already exists at line ${existing.get(args.title)}`,
    );
  }

  // Render and insert.
  const text = renderTestStatement(args.title, args.body);

  // Both SourceFile and Block expose getStatements / insertStatements via
  // ts-morph's StatementedNode. Compute the index and insert uniformly.
  const statements = scope.getStatements();
  const index = args.position === 'start' ? 0 : statements.length;
  const inserted = scope.insertStatements(index, text);

  // insertStatements returns an array; the new test is the single inserted statement.
  const first = inserted[0];
  return {
    startLine: first.getStartLineNumber(),
    endLine: first.getEndLineNumber(),
  };
}
