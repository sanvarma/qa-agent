export class ToolRegistry {
    tools = new Map();
    register(tool) {
        if (this.tools.has(tool.name)) {
            throw new Error(`tool already registered: ${tool.name}`);
        }
        this.tools.set(tool.name, tool);
    }
    specs() {
        return [...this.tools.values()].map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.jsonSchema,
        }));
    }
    async dispatch(call, ctx) {
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
        }
        catch (err) {
            return {
                id: call.id,
                ok: false,
                output: null,
                error: err instanceof Error ? err.message : String(err),
            };
        }
    }
}
//# sourceMappingURL=registry.js.map