import type { LLMClient, LLMRequest, ToolSpec } from './client.js';
import type { AssistantTurn, Turn, ToolCall } from '../agent/types.js';

/**
 * Ollama LLM adapter.
 *
 * Targets Ollama's /api/chat endpoint with native tool support
 * (Ollama 0.3+ on tool-capable models like qwen2.5/qwen3, llama3.1+, mistral-nemo, etc).
 *
 * Two things to know:
 *
 *  1. Tool calling on Ollama works only if the underlying model was trained
 *     for it. If the model emits free-text instead of `tool_calls`, the agent
 *     loop will see toolCalls=[] and stop. That's a model capability problem,
 *     not an adapter bug.
 *
 *  2. Ollama doesn't stream tool_call IDs the way OpenAI does. We synthesize
 *     stable IDs (`oc_<n>`) so ConversationLog can correlate calls to results across
 *     turns. The IDs are local to this conversation; nothing else cares.
 */

interface OllamaChatRequest {
  model: string;
  messages: OllamaMessage[];
  tools?: OllamaTool[];
  stream: false;
  options?: {
    num_predict?: number;
    temperature?: number;
  };
}

type OllamaMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | {
      role: 'assistant';
      content: string;
      tool_calls?: OllamaToolCall[];
    }
  | { role: 'tool'; content: string };

interface OllamaToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OllamaChatResponse {
  model: string;
  message: {
    role: 'assistant';
    content: string;
    tool_calls?: OllamaToolCall[];
  };
  done: boolean;
  done_reason?: string;
}

export interface OllamaClientOptions {
  url: string;          // e.g. https://...runpod.net  (no trailing /api/chat)
  defaultModel?: string;
  // Optional sampling knobs. Kept minimal — most callers won't need this.
  temperature?: number;
}

export class OllamaClient implements LLMClient {
  readonly name = 'ollama';
  private callCounter = 0;

  constructor(private readonly opts: OllamaClientOptions) {}

  async complete(req: LLMRequest): Promise<AssistantTurn> {
    const messages = this.translateHistory(req.system, req.history);
    const tools = req.tools.length > 0 ? req.tools.map(toOllamaTool) : undefined;

    const payload: OllamaChatRequest = {
      model: req.model && req.model !== 'unset' ? req.model : (this.opts.defaultModel ?? 'qwen2.5'),
      messages,
      tools,
      stream: false,
      options: {
        num_predict: req.maxTokens,
        ...(this.opts.temperature !== undefined ? { temperature: this.opts.temperature } : {}),
      },
    };

    const url = `${this.opts.url.replace(/\/$/, '')}/api/chat`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Ollama HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as OllamaChatResponse;

    const toolCalls = (json.message.tool_calls ?? []).map((tc): ToolCall => {
      this.callCounter += 1;
      const args =
        typeof tc.function.arguments === 'string'
          ? safeParseJsonObject(tc.function.arguments)
          : tc.function.arguments;
      return {
        id: `oc_${this.callCounter}`,
        name: tc.function.name,
        input: args,
      };
    });

    const stopReason: AssistantTurn['stopReason'] =
      toolCalls.length > 0 ? 'tool_use' : json.done_reason === 'length' ? 'max_tokens' : 'end_turn';

    return {
      text: json.message.content || undefined,
      toolCalls,
      stopReason,
    };
  }

  /**
   * Convert vendor-neutral Turn[] + system into Ollama's messages array.
   *
   * Tool results in our model live inside a single user turn (`UserTurn.toolResults`).
   * Ollama wants each tool result as its own message with role='tool'. So one
   * UserTurn with N tool results expands into N tool messages. If the same UserTurn
   * also has text, the text becomes a separate user message AFTER the tool messages.
   */
  private translateHistory(system: string, history: Turn[]): OllamaMessage[] {
    const out: OllamaMessage[] = [{ role: 'system', content: system }];

    for (const turn of history) {
      if (turn.role === 'user') {
        for (const r of turn.content.toolResults) {
          out.push({
            role: 'tool',
            content: stringifyToolOutput(r),
          });
        }
        if (turn.content.text) {
          out.push({ role: 'user', content: turn.content.text });
        }
        continue;
      }

      // assistant
      const a = turn.content;
      const ollamaToolCalls = a.toolCalls.map(
        (tc): OllamaToolCall => ({
          function: {
            name: tc.name,
            arguments:
              tc.input && typeof tc.input === 'object' && !Array.isArray(tc.input)
                ? (tc.input as Record<string, unknown>)
                : { value: tc.input },
          },
        }),
      );
      out.push({
        role: 'assistant',
        content: a.text ?? '',
        ...(ollamaToolCalls.length > 0 ? { tool_calls: ollamaToolCalls } : {}),
      });
    }

    return out;
  }
}

function toOllamaTool(spec: ToolSpec): OllamaTool {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: spec.inputSchema,
    },
  };
}

function stringifyToolOutput(r: { ok: boolean; output: unknown; error?: string }): string {
  if (!r.ok) {
    return JSON.stringify({ ok: false, error: r.error ?? 'unknown error' });
  }
  // Output may already be a string. Wrap consistently so the model always sees JSON.
  return JSON.stringify({ ok: true, output: r.output });
}

function safeParseJsonObject(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { value: v };
  } catch {
    return { raw: s };
  }
}
