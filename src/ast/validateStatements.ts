import { Project } from 'ts-morph';

export class StatementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StatementParseError';
  }
}

/**
 * Validate that `source` parses as a sequence of statements inside an async
 * function body. Throws StatementParseError on syntactic failure.
 *
 * Resolution errors (unknown names, missing modules, implicit-any params) are
 * intentionally ignored — the probe scope doesn't include the user's imports,
 * fixture params, or global types, and those are not what this check is for.
 */
export function validateStatements(source: string): void {
  const probe = new Project({ useInMemoryFileSystem: true });
  const sf = probe.createSourceFile(
    '__probe__.ts',
    `async function __probe__() {\n${source}\n}\n`,
    { overwrite: true },
  );

  const resolutionCodes = new Set([
    2304, // Cannot find name
    2307, // Cannot find module
    2552, // Cannot find name (did you mean...)
    2580, // Cannot find name 'require' / similar
    7006, // Parameter implicitly has an 'any' type
  ]);

  const diagnostics = sf.getPreEmitDiagnostics().filter((d) => !resolutionCodes.has(d.getCode()));
  if (diagnostics.length === 0) return;

  const first = diagnostics[0];
  const text = first.getMessageText();
  const msg = typeof text === 'string' ? text : text.toString();
  throw new StatementParseError(msg);
}
