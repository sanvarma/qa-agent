import { McpStdioClient } from './client.js';
import { federateMcpTool } from './federate.js';
/**
 * Tool names we expose to the LLM, post-namespacing.
 * Whatever @playwright/mcp exposes beyond this set is hidden.
 *
 * Kept curated (rather than "all") because:
 *  - the LLM's prompt is clearer when tool lists are short;
 *  - features we don't need (screenshots, tab management, downloads,
 *    network mocking) introduce failure modes we don't want to handle yet.
 */
const CURATED_BROWSE_TOOLS = new Set([
    'browse.navigate',
    'browse.snapshot',
    'browse.click',
    'browse.type',
    'browse.hover',
]);
/**
 * Start @playwright/mcp, federate its curated tools under the `browse`
 * namespace, and return them as AnyTool[] for registration by the caller.
 * Caller must call handle.stop() on exit.
 */
export async function startPlaywrightMcp(options = {}) {
    // The @playwright/mcp package exposes a CLI bin. We invoke it via `npx`
    // so the user doesn't have to have a global install — Node will use the
    // repo's node_modules copy.
    const client = new McpStdioClient('npx', ['-y', '@playwright/mcp', ...(options.extraArgs ?? [])], 
    // Env: let the server inherit PATH so it can find its own browser binaries.
    {});
    await client.connect();
    const allTools = await client.listTools();
    const tools = [];
    const registeredToolNames = [];
    for (const spec of allTools) {
        const federated = federateMcpTool(spec, 'browse', client);
        if (!CURATED_BROWSE_TOOLS.has(federated.name))
            continue;
        tools.push(federated);
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
//# sourceMappingURL=playwrightServer.js.map