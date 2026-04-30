// Vendor-neutral tool-use protocol.
// Any LLMClient adapter must translate its provider's format into these shapes.

export interface ToolCall {
  id: string;        // correlates a call to its result
  name: string;      // e.g. "fs.read"
  input: unknown;    // validated by the tool's zod schema
}

export interface ToolResult {
  id: string;        // must match ToolCall.id
  ok: boolean;
  output: unknown;   // JSON-serializable
  error?: string;
  toolName?: string; // set by the agent loop; used for history compression
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface AssistantTurn {
  text?: string;             // natural-language reasoning/commentary
  toolCalls: ToolCall[];     // zero or more tool calls this turn
  stopReason: 'tool_use' | 'end_turn' | 'max_tokens' | 'other';
  usage?: TokenUsage;        // token counts for this completion (if provider reports them)
}

export interface UserTurn {
  text?: string;
  toolResults: ToolResult[];
}

export type Turn =
  | { role: 'user'; content: UserTurn }
  | { role: 'assistant'; content: AssistantTurn };
