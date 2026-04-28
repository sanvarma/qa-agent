import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
/**
 * Thin wrapper around an MCP stdio client. One instance represents one
 * connection to one MCP server subprocess.
 *
 * Lifecycle is explicit: `connect()` spawns the server and handshakes;
 * `close()` shuts it down. Callers must close() or we leak a subprocess.
 */
export class McpStdioClient {
    command;
    args;
    env;
    client;
    transport;
    connected = false;
    constructor(command, args = [], env = {}, clientIdentity = { name: 'qa-agent', version: '0.0.1' }) {
        this.command = command;
        this.args = args;
        this.env = env;
        this.client = new Client({ name: clientIdentity.name, version: clientIdentity.version }, { capabilities: {} });
    }
    async connect() {
        if (this.connected)
            return;
        this.transport = new StdioClientTransport({
            command: this.command,
            args: this.args,
            env: { ...process.env, ...this.env },
        });
        await this.client.connect(this.transport);
        this.connected = true;
    }
    async listTools() {
        this.ensureConnected();
        const result = await this.client.listTools();
        return (result.tools ?? []).map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: (t.inputSchema ?? { type: 'object' }),
        }));
    }
    async callTool(name, args) {
        this.ensureConnected();
        const result = await this.client.callTool({ name, arguments: args });
        return {
            content: result.content ?? [],
            isError: result.isError === true,
        };
    }
    async close() {
        if (!this.connected)
            return;
        try {
            await this.client.close();
        }
        finally {
            this.connected = false;
            this.transport = undefined;
        }
    }
    ensureConnected() {
        if (!this.connected) {
            throw new Error('McpStdioClient is not connected — call connect() first');
        }
    }
}
//# sourceMappingURL=client.js.map