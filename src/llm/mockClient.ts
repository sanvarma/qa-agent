import type { LLMClient, LLMRequest } from './client.js';
import type { AssistantTurn } from '../agent/types.js';

// A scripted turn the mock will emit, in order, one per complete() call.
export type ScriptedTurn = AssistantTurn;

/**
 * MockLLMClient: replays a fixed sequence of assistant turns.
 * This exists so the agent loop can be exercised end-to-end without a real LLM.
 * When a real adapter is added, it implements the same LLMClient interface.
 */
export class MockLLMClient implements LLMClient {
  readonly name = 'mock';
  private cursor = 0;

  constructor(private readonly script: ScriptedTurn[]) {}

  async complete(_req: LLMRequest): Promise<AssistantTurn> {
    if (this.cursor >= this.script.length) {
      // Safety: if the agent over-runs the script, end cleanly.
      return { toolCalls: [], stopReason: 'end_turn' };
    }
    const turn = this.script[this.cursor++];
    return turn;
  }
}
