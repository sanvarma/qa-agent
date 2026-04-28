import { SourceFile, ImportDeclaration } from 'ts-morph';

export type ImportErrorCode = 'conflicting_default' | 'nothing_to_add';

export class ImportError extends Error {
  constructor(public code: ImportErrorCode, message: string) {
    super(message);
    this.name = 'ImportError';
  }
}

export interface AddImportArgs {
  moduleSpecifier: string;
  named?: string[];
  defaultName?: string;
  typeOnly?: boolean;
}

export interface AddImportResult {
  changed: boolean;
  added: { named: string[]; default: string | null };
}

/**
 * Idempotently ensure the given imports are present.
 *
 * Behavior:
 *   - If there is no existing import from this module, a new import declaration
 *     is appended to the file's import block (after the last existing import,
 *     or at the top if none exist).
 *   - If an import from this module already exists, named imports are merged
 *     into it (alphabetical). A default import is added only if there's no
 *     existing default on the declaration; if the existing default differs
 *     from the requested one, throws ImportError('conflicting_default').
 *   - typeOnly requests match/merge only with existing type-only imports of
 *     the same module; a value import and a type import for the same module
 *     stay as separate declarations (matches standard TS behavior).
 *
 * Returns { changed: false, added: { named: [], default: null } } when
 * everything requested was already present.
 */
export function addImport(sf: SourceFile, args: AddImportArgs): AddImportResult {
  const requestedNamed = Array.from(new Set(args.named ?? []));
  const requestedDefault = args.defaultName;

  if (requestedNamed.length === 0 && !requestedDefault) {
    throw new ImportError('nothing_to_add', 'neither named nor default imports provided');
  }

  const typeOnly = args.typeOnly === true;

  // Find an existing import declaration from this module matching typeOnly-ness.
  const existing = sf
    .getImportDeclarations()
    .find(
      (d) => d.getModuleSpecifierValue() === args.moduleSpecifier && d.isTypeOnly() === typeOnly,
    );

  const addedNamed: string[] = [];
  let addedDefault: string | null = null;

  if (existing) {
    // Merge named imports.
    const existingNamed = new Set(existing.getNamedImports().map((n) => n.getName()));
    const toAdd = requestedNamed.filter((n) => !existingNamed.has(n));
    if (toAdd.length > 0) {
      existing.addNamedImports(toAdd.map((name) => ({ name })));
      addedNamed.push(...toAdd);
    }

    // Merge default import.
    if (requestedDefault) {
      const currentDefault = existing.getDefaultImport()?.getText();
      if (!currentDefault) {
        existing.setDefaultImport(requestedDefault);
        addedDefault = requestedDefault;
      } else if (currentDefault !== requestedDefault) {
        throw new ImportError(
          'conflicting_default',
          `module '${args.moduleSpecifier}' is already imported with default '${currentDefault}', cannot also use '${requestedDefault}'`,
        );
      }
      // else: same default already present — no-op
    }

    // Sort named imports for deterministic output. Only re-sort if we added anything.
    if (addedNamed.length > 0) {
      sortNamedImports(existing);
    }
  } else {
    // No existing declaration — create one. ts-morph places it at the top by default,
    // but we want it after any other imports for a tidy import block.
    const allImports = sf.getImportDeclarations();
    const insertIndex = allImports.length; // append to import block

    sf.insertImportDeclaration(insertIndex, {
      moduleSpecifier: args.moduleSpecifier,
      namedImports: requestedNamed.sort().map((name) => ({ name })),
      defaultImport: requestedDefault,
      isTypeOnly: typeOnly,
    });

    addedNamed.push(...requestedNamed);
    if (requestedDefault) addedDefault = requestedDefault;
  }

  const changed = addedNamed.length > 0 || addedDefault !== null;
  return {
    changed,
    added: { named: addedNamed, default: addedDefault },
  };
}

function sortNamedImports(decl: ImportDeclaration): void {
  const names = decl.getNamedImports().map((n) => n.getName());
  const sorted = [...names].sort();
  if (names.every((n, i) => n === sorted[i])) return;
  decl.removeNamedImports();
  decl.addNamedImports(sorted.map((name) => ({ name })));
}
