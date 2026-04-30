import { McpStdioClient } from './client.js';
import { federateMcpTool } from './federate.js';
import type { AnyTool } from '../tools/tool.js';

/**
 * Tool names we expose to the LLM, post-namespacing.
 * Whatever @playwright/mcp exposes beyond this set is hidden.
 *
 * Kept curated (rather than "all") because:
 *  - the LLM's prompt is clearer when tool lists are short;
 *  - features we don't need (screenshots, tab management, downloads,
 *    network mocking) introduce failure modes we don't want to handle yet.
 */
const CURATED_BROWSE_TOOLS: ReadonlySet<string> = new Set([
  'browse.navigate',
  'browse.snapshot',
  'browse.click',
  'browse.type',
  'browse.hover',
  'browse.evaluate',
]);

export interface PlaywrightMcpOptions {
  /**
   * Extra args passed to @playwright/mcp's server binary. Empty is fine for
   * most use — the package's defaults (chromium, headless) are sensible.
   */
  extraArgs?: string[];
  /** Truncate browse.snapshot text responses to this many lines (default 150). */
  maxSnapshotLines?: number;
}

export interface PlaywrightMcpHandle {
  client: McpStdioClient;
  /** The federated tools, for registration into per-phase registries. */
  tools: AnyTool[];
  /** Tool names (for logging / diagnostics). */
  registeredToolNames: string[];
  /** Call on shutdown to stop the MCP subprocess. Idempotent. */
  stop(): Promise<void>;
}

/**
 * Start @playwright/mcp, federate its curated tools under the `browse`
 * namespace, and return them as AnyTool[] for registration by the caller.
 * Caller must call handle.stop() on exit.
 */
export async function startPlaywrightMcp(
  options: PlaywrightMcpOptions = {},
): Promise<PlaywrightMcpHandle> {
  // The @playwright/mcp package exposes a CLI bin. We invoke it via `npx`
  // so the user doesn't have to have a global install — Node will use the
  // repo's node_modules copy.
  const client = new McpStdioClient(
    'npx',
    ['-y', '@playwright/mcp', ...(options.extraArgs ?? [])],
    // Env: let the server inherit PATH so it can find its own browser binaries.
    {},
  );

  await client.connect();

  const allTools = await client.listTools();
  const tools: AnyTool[] = [];
  const registeredToolNames: string[] = [];

  const maxSnapshotLines = options.maxSnapshotLines ?? 150;

  for (const spec of allTools) {
    const federated = federateMcpTool(spec, 'browse', client, { maxSnapshotLines });
    if (!CURATED_BROWSE_TOOLS.has(federated.name)) continue;
    tools.push(federated as unknown as AnyTool);
    registeredToolNames.push(federated.name);
  }

  return {
    client,
    tools,
    registeredToolNames,
    async stop() {
      await client.close();
    },
  };
}
