import Anthropic from '@anthropic-ai/sdk';
import type { LLMClient, LLMRequest, ToolSpec } from './client.js';
import type { AssistantTurn, Turn } from '../agent/types.js';

export interface AnthropicClientOptions {
  apiKey?: string; // falls back to ANTHROPIC_API_KEY env var
}

// Anthropic tool names must match ^[a-zA-Z0-9_-]{1,128}$
// Our internal names use dots (e.g. fs.read) — encode/decode on the boundary.
function encodeToolName(name: string): string {
  return name.replace(/\./g, '__');
}
function decodeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

export class AnthropicClient implements LLMClient {
  readonly name = 'anthropic';
  private readonly sdk: Anthropic;

  constructor(opts: AnthropicClientOptions = {}) {
    this.sdk = new Anthropic({
      apiKey: opts.apiKey ?? process.env.ANTHROPIC_API_KEY,
      timeout: 120_000, // 2 minutes per call
    });
  }

  async complete(req: LLMRequest): Promise<AssistantTurn> {
    const messages = translateHistory(req.history);
    const tools = req.tools.map(toAnthropicTool);

    const response = await this.sdk.messages.create({
      model: req.model,
      max_tokens: req.maxTokens,
      system: req.system,
      messages,
      tools: tools.length > 0 ? tools : undefined,
    });

    const textBlock = response.content.find((b) => b.type === 'text');
    const toolCallBlocks = response.content.filter((b) => b.type === 'tool_use');

    const toolCalls = toolCallBlocks.map((b) => {
      const block = b as Anthropic.ToolUseBlock;
      return {
        id: block.id,
        name: decodeToolName(block.name),
        input: block.input as Record<string, unknown>,
      };
    });

    const stopReason: AssistantTurn['stopReason'] =
      toolCalls.length > 0
        ? 'tool_use'
        : response.stop_reason === 'max_tokens'
          ? 'max_tokens'
          : 'end_turn';

    return {
      text: textBlock?.type === 'text' ? textBlock.text || undefined : undefined,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

function toAnthropicTool(spec: ToolSpec): Anthropic.Tool {
  return {
    name: encodeToolName(spec.name),
    description: spec.description,
    input_schema: spec.inputSchema as Anthropic.Tool['input_schema'],
  };
}

/**
 * Convert vendor-neutral Turn[] into Anthropic's messages array.
 *
 * Anthropic's format:
 *  - Assistant turns: content is an array of text + tool_use blocks
 *  - User turns with tool results: content is an array of tool_result blocks,
 *    optionally followed by a text block
 */
function translateHistory(history: Turn[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const turn of history) {
    if (turn.role === 'user') {
      const content: Anthropic.MessageParam['content'] = [];

      for (const r of turn.content.toolResults) {
        content.push({
          type: 'tool_result',
          tool_use_id: r.id,
          content: stringifyToolOutput(r),
          is_error: !r.ok,
        } as Anthropic.ToolResultBlockParam);
      }

      if (turn.content.text) {
        content.push({ type: 'text', text: turn.content.text });
      }

      if (content.length > 0) {
        out.push({ role: 'user', content });
      }
      continue;
    }

    // assistant turn
    const a = turn.content;
    const content: Anthropic.ContentBlock[] = [];

    if (a.text) {
      content.push({ type: 'text', text: a.text });
    }

    for (const tc of a.toolCalls) {
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: encodeToolName(tc.name),
        input: tc.input as Record<string, unknown>,
      });
    }

    if (content.length > 0) {
      out.push({ role: 'assistant', content });
    }
  }

  return out;
}

function stringifyToolOutput(r: { ok: boolean; output: unknown; error?: string }): string {
  if (!r.ok) {
    return JSON.stringify({ ok: false, error: r.error ?? 'unknown error' });
  }
  return JSON.stringify({ ok: true, output: r.output });
}
