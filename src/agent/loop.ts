import type { LLMClient } from '../llm/client.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/tool.js';
import type { ConversationLog } from './conversationLog.js';
import type { Turn, ToolResult } from './types.js';

export interface AgentOptions {
  maxSteps: number;
  model: string;
  maxTokens: number;
  system: string;
}

export interface AgentDeps {
  llm: LLMClient;
  tools: ToolRegistry;
  toolCtx: ToolContext;
  state: ConversationLog;
}

export type StopReason = 'end_turn' | 'max_steps' | 'max_tokens' | 'other';

export interface AgentResult {
  stopReason: StopReason;
  steps: number;
}

/**
 * The loop is intentionally flat and synchronous in shape:
 *   1. ask LLM for next turn
 *   2. record assistant turn
 *   3. if no tool calls -> stop
 *   4. dispatch every tool call, collect results
 *   5. record user turn with results
 *   6. loop, up to maxSteps
 *
 * Every turn is appended to ConversationLog. Log is persisted by the caller.
 */
export async function runAgent(
  task: string,
  opts: AgentOptions,
  deps: AgentDeps,
): Promise<AgentResult> {
  const { llm, tools, toolCtx, state } = deps;

  // Seed conversation with the user task.
  state.append({ role: 'user', content: { text: task, toolResults: [] } });

  for (let step = 1; step <= opts.maxSteps; step++) {
    const assistant = await llm.complete({
      system: opts.system,
      tools: tools.specs(),
      history: state.turns,
      model: opts.model,
      maxTokens: opts.maxTokens,
    });

    const assistantTurn: Turn = { role: 'assistant', content: assistant };
    state.append(assistantTurn);

    if (assistant.toolCalls.length === 0) {
      return { stopReason: assistant.stopReason === 'end_turn' ? 'end_turn' : 'other', steps: step };
    }

    // Dispatch all tool calls for this turn. Sequential for determinism.
    const results: ToolResult[] = [];
    for (const call of assistant.toolCalls) {
      const res = await tools.dispatch(call, toolCtx);
      results.push(res);
    }

    state.append({ role: 'user', content: { toolResults: results } });
  }

  return { stopReason: 'max_steps', steps: opts.maxSteps };
}
