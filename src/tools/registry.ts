import type { AnyTool, Tool, ToolContext } from './tool.js';
import type { ToolCall, ToolResult } from '../agent/types.js';
import type { ToolSpec } from '../llm/client.js';

export class ToolRegistry {
  private readonly tools = new Map<string, AnyTool>();

  register<I, O>(tool: Tool<I, O>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this.tools.set(tool.name, tool as unknown as AnyTool);
  }

  specs(): ToolSpec[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.jsonSchema,
    }));
  }

  async dispatch(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { id: call.id, ok: false, output: null, error: `unknown tool: ${call.name}` };
    }
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return {
        id: call.id,
        ok: false,
        output: null,
        error: `invalid input: ${parsed.error.message}`,
      };
    }
    try {
      const output = await tool.run(parsed.data, ctx);
      return { id: call.id, ok: true, output };
    } catch (err) {
      return {
        id: call.id,
        ok: false,
        output: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
