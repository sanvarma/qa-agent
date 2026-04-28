import { Project, SourceFile } from 'ts-morph';

/**
 * Build a SourceFile from a raw string using an in-memory ts-morph Project.
 *
 * Each call creates a fresh Project — AST tests should not share state. The
 * cost is trivial (ts-morph's Project is light in-memory) and isolation is
 * worth far more than the microseconds saved.
 *
 * The filename controls how ts-morph parses the source. Defaults to .ts;
 * pass '.spec.js' or a custom path if a test needs a specific shape.
 */
export function makeSourceFile(source: string, filename = 'file.js'): SourceFile {
  const project = new Project({ useInMemoryFileSystem: true });
  return project.createSourceFile(filename, source, { overwrite: true });
}
