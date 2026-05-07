import { ClassDeclaration, MethodDeclaration } from 'ts-morph';
import { validateStatements, StatementParseError } from './validateStatements.js';

export type MethodEditErrorCode = 'no_body' | 'body_parse_failed';

export class MethodEditError extends Error {
  constructor(public code: MethodEditErrorCode, message: string) {
    super(message);
    this.name = 'MethodEditError';
  }
}

/**
 * Replace the body block of an existing method.
 * Preserves: method name, parameters, async, static, visibility, return type,
 * decorators, overload signatures. Only the { ... } block is swapped.
 */
export function replaceMethodBody(method: MethodDeclaration, newBody: string): void {
  if (method.getBody() === undefined) {
    throw new MethodEditError('no_body', 'method has no body to replace');
  }

  try {
    validateStatements(newBody);
  } catch (err) {
    if (err instanceof StatementParseError) {
      throw new MethodEditError('body_parse_failed', `newBody failed to parse: ${err.message}`);
    }
    throw err;
  }

  method.setBodyText(newBody);
}

/** Parse "username: string, password: string" → ParameterDeclarationStructure[]. */
function parseParams(params: string): { name: string; type: string }[] {
  if (!params.trim()) return [];
  return params.split(',').map((p) => {
    const colonIdx = p.indexOf(':');
    if (colonIdx === -1) return { name: p.trim(), type: 'unknown' };
    return { name: p.slice(0, colonIdx).trim(), type: p.slice(colonIdx + 1).trim() };
  });
}

export interface AddMethodOptions {
  name: string;
  params: string;
  isAsync: boolean;
  returnType: string;
  body: string;
}

/**
 * Add a new method to a class. Validates the body before writing.
 */
export function addMethod(cls: ClassDeclaration, opts: AddMethodOptions): MethodDeclaration {
  try {
    validateStatements(opts.body);
  } catch (err) {
    if (err instanceof StatementParseError) {
      throw new MethodEditError('body_parse_failed', `newBody failed to parse: ${err.message}`);
    }
    throw err;
  }

  return cls.addMethod({
    name: opts.name,
    isAsync: opts.isAsync,
    parameters: parseParams(opts.params),
    returnType: opts.returnType,
    statements: opts.body,
  });
}
