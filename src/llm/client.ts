import type { AssistantTurn, Turn } from '../agent/types.js';

// A tool as the LLM sees it. Providers convert this into their own schema.
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema
}

export interface LLMRequest {
  system: string;
  tools: ToolSpec[];
  history: Turn[];
  model: string;
  maxTokens: number;
}

export interface LLMClient {
  readonly name: string;
  complete(req: LLMRequest): Promise<AssistantTurn>;
}
