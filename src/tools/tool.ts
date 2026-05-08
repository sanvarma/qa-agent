import type { ZodType, ZodTypeDef } from 'zod';

export interface ToolContext {
  // Absolute, resolved root of the repo the agent is operating on.
  // Tools MUST refuse to read/write outside this root.
  repoRoot: string;
  // Absolute path to the current run's directory (e.g. .qa-agent/runs/<id>/).
  // Tools that produce artifacts (test reports, traces, screenshots) write
  // under runDir/artifacts/. Optional so tools that don't need it are unaffected.
  runDir?: string;
  // Target-repo layout, resolved from Config.paths. Relative to repoRoot.
  // Mutating tools enforce write scope against these (tests/ for test.*, pages/ for pom.*).
  // Optional so tools that don't care about scope (e.g. exec.*, fs.read) are unaffected.
  paths?: {
    pages: string;
    tests: string;
  };
  // Selector priority order from qa-agent.config.json browse.selectorPreference
  selectorPreference?: string[];
}

export interface Tool<I, O> {
  readonly name: string;
  readonly description: string;
  // ZodType<Output, Def, Input>: we care that the PARSED output matches I.
  // The raw input may legitimately differ (e.g. z.default(x) accepts undefined
  // but yields a concrete T). Leaving Input unconstrained avoids false
  // incompatibilities while still type-checking the parsed value as I.
  readonly inputSchema: ZodType<I, ZodTypeDef, unknown>;
  // JSON Schema form for the LLM. Kept separate so we don't force a zod->jsonschema dep yet.
  readonly jsonSchema: Record<string, unknown>;
  run(input: I, ctx: ToolContext): Promise<O>;
}

export type AnyTool = Tool<unknown, unknown>;
