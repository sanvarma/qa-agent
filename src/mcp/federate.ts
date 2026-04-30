import { z } from 'zod';
import type { Tool } from '../tools/tool.js';
import type { McpStdioClient, McpCallResult, McpToolSpec } from './client.js';

export interface FederateOptions {
  /** If set, truncates large text blocks in ALL browse tool responses to this
   *  many lines. browse.navigate and browse.click both return inline page
   *  snapshots that can be 900+ lines on product listing pages. A trailing
   *  note is appended so the LLM knows the output was cut. */
  maxSnapshotLines?: number;
}

function truncateSnapshotContent(result: McpCallResult, maxLines: number): McpCallResult {
  const content = result.content.map((block) => {
    if (typeof (block as { type?: string }).type !== 'string') return block;
    const b = block as { type: string; text?: string };
    if (b.type !== 'text' || !b.text) return block;
    const lines = b.text.split('\n');
    if (lines.length <= maxLines) return block;
    const truncated = lines.slice(0, maxLines).join('\n');
    return { ...b, text: `${truncated}\n\n[snapshot truncated: showed ${maxLines} of ${lines.length} lines]` };
  });
  return { ...result, content };
}

/**
 * Convert one MCP tool spec into our internal Tool<I, O> shape.
 *
 * The resulting tool:
 *  - is named `${namespace}.${originalName}` so multiple federated servers
 *    can't collide (e.g. two servers each exposing "status");
 *  - accepts any object input via a permissive zod schema (MCP servers
 *    validate their own input; duplicating that validation wastes effort
 *    and can drift);
 *  - forwards the JSON Schema verbatim to jsonSchema so the LLM sees what
 *    the server actually advertises;
 *  - dispatches via the shared McpStdioClient.
 *
 * Tools built this way intentionally have NO scope enforcement, because
 * MCP tools don't write to the repo — they operate on an external browser
 * (or whatever the server controls). If that assumption ever breaks (an
 * MCP server that edits files), we'll need per-server policy here.
 */
export function federateMcpTool(
  spec: McpToolSpec,
  namespace: string,
  client: McpStdioClient,
  opts: FederateOptions = {},
): Tool<Record<string, unknown>, McpCallResult> {
  const toolName = `${namespace}.${stripBrowserPrefix(spec.name)}`;

  // Permissive input: accept any object. The MCP server is authoritative on
  // argument shape. We pass through whatever the LLM sends.
  const inputSchema = z.record(z.unknown());

  return {
    name: toolName,
    description:
      spec.description ??
      `Federated MCP tool '${spec.name}' from namespace '${namespace}'.`,
    inputSchema,
    jsonSchema: spec.inputSchema,
    async run(input) {
      // Pass the ORIGINAL MCP tool name on the wire — we only renamed it
      // for our registry. The server still knows it as spec.name.
      const result = await client.callTool(spec.name, input);
      if (opts.maxSnapshotLines) {
        return truncateSnapshotContent(result, opts.maxSnapshotLines);
      }
      return result;
    },
  };
}

/**
 * Playwright MCP prefixes most tools with "browser_". That's redundant
 * once we've already namespaced under "browse". We strip the prefix so
 * `browser_navigate` becomes `browse.navigate`, matching our convention.
 */
function stripBrowserPrefix(name: string): string {
  return name.startsWith('browser_') ? name.slice('browser_'.length) : name;
}
