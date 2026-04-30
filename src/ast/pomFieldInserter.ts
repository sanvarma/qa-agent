import { ClassDeclaration, Node } from 'ts-morph';

export type InsertFieldErrorCode =
  | 'duplicate_field'
  | 'no_insertion_point';

export class InsertFieldError extends Error {
  constructor(public code: InsertFieldErrorCode, message: string) {
    super(message);
    this.name = 'InsertFieldError';
  }
}

export interface InsertFieldArgs {
  name: string;       // e.g. "searchInput"
  selector: string;   // raw selector string, e.g. "#search-input"
  description?: string;
}

export interface InsertFieldResult {
  startLine: number;
  endLine: number;
}

/**
 * Add a new `readonly <name> = this.loc("<selector>");` property to a POM class.
 *
 * Insertion order:
 *   1. After the last existing readonly property initializer in the class body.
 *   2. If no readonly properties exist, before the constructor.
 *   3. If no constructor either, at index 0 of the class body.
 *
 * Refuses if a member with the same name already exists.
 */
export function insertPomField(cls: ClassDeclaration, args: InsertFieldArgs): InsertFieldResult {
  // Duplicate check — any member (property or method) with the same name.
  const existing = cls.getMembers().find((m) => {
    if (Node.isPropertyDeclaration(m) || Node.isMethodDeclaration(m)) {
      return m.getName() === args.name;
    }
    return false;
  });
  if (existing) {
    throw new InsertFieldError(
      'duplicate_field',
      `member '${args.name}' already exists on class '${cls.getName()}'`,
    );
  }

  // Escape selector for use inside double-quoted string.
  const escaped = args.selector.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const fieldText = `readonly ${args.name} = this.loc("${escaped}");`;

  // Build optional leading JSDoc.
  const lines: string[] = [];
  if (args.description) {
    lines.push(`/** ${args.description} */`);
  }
  lines.push(fieldText);
  const memberText = lines.join('\n');

  // Find insertion index.
  const members = cls.getMembers();

  // Walk backwards to find the last readonly property.
  let lastReadonlyPropIndex = -1;
  for (let i = members.length - 1; i >= 0; i--) {
    const m = members[i];
    if (Node.isPropertyDeclaration(m) && m.isReadonly()) {
      lastReadonlyPropIndex = i;
      break;
    }
  }

  let insertIndex: number;
  if (lastReadonlyPropIndex >= 0) {
    // Insert right after the last readonly property.
    insertIndex = lastReadonlyPropIndex + 1;
  } else {
    // Fall back: before the constructor, or at start if no constructor.
    const ctorIndex = members.findIndex((m) => Node.isConstructorDeclaration(m));
    insertIndex = ctorIndex >= 0 ? ctorIndex : 0;
  }

  const inserted = cls.insertMember(insertIndex, memberText);
  return {
    startLine: inserted.getStartLineNumber(),
    endLine: inserted.getEndLineNumber(),
  };
}
