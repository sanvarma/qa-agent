/**
 * MockLLMClient: replays a fixed sequence of assistant turns.
 * This exists so the agent loop can be exercised end-to-end without a real LLM.
 * When a real adapter is added, it implements the same LLMClient interface.
 */
export class MockLLMClient {
    script;
    name = 'mock';
    cursor = 0;
    constructor(script) {
        this.script = script;
    }
    async complete(_req) {
        if (this.cursor >= this.script.length) {
            // Safety: if the agent over-runs the script, end cleanly.
            return { toolCalls: [], stopReason: 'end_turn' };
        }
        const turn = this.script[this.cursor++];
        return turn;
    }
}
//# sourceMappingURL=mockClient.js.map