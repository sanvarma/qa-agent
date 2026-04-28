import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

/**
 * Shape of a tool as reported by an MCP server.
 * We keep this narrow to what we actually use — the SDK's own type is wider.
 */
export interface McpToolSpec {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;  // JSON Schema
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string } | Record<string, unknown>>;
  isError?: boolean;
}

/**
 * Thin wrapper around an MCP stdio client. One instance represents one
 * connection to one MCP server subprocess.
 *
 * Lifecycle is explicit: `connect()` spawns the server and handshakes;
 * `close()` shuts it down. Callers must close() or we leak a subprocess.
 */
export class McpStdioClient {
  private client: Client;
  private transport?: StdioClientTransport;
  private connected = false;

  constructor(
    private readonly command: string,
    private readonly args: string[] = [],
    private readonly env: Record<string, string> = {},
    clientIdentity: { name: string; version: string } = { name: 'qa-agent', version: '0.0.1' },
  ) {
    this.client = new Client(
      { name: clientIdentity.name, version: clientIdentity.version },
      { capabilities: {} },
    );
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    this.transport = new StdioClientTransport({
      command: this.command,
      args: this.args,
      env: { ...process.env, ...this.env } as Record<string, string>,
    });
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async listTools(): Promise<McpToolSpec[]> {
    this.ensureConnected();
    const result = await this.client.listTools();
    return (result.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: (t.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    this.ensureConnected();
    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: (result.content as McpCallResult['content']) ?? [],
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.close();
    } finally {
      this.connected = false;
      this.transport = undefined;
    }
  }

  private ensureConnected(): void {
    if (!this.connected) {
      throw new Error('McpStdioClient is not connected — call connect() first');
    }
  }
}
