import type { LLMClient, LLMRequest, ToolSpec } from './client.js';
import type { AssistantTurn, Turn, ToolCall } from '../agent/types.js';

export interface OpenAIClientOptions {
  baseUrl: string;   // e.g. https://api.groq.com/openai
  apiKey?: string;   // falls back to GROQ_API_KEY env var
  defaultModel?: string;
}

interface OpenAIChatRequest {
  model: string;
  messages: OpenAIMessage[];
  tools?: OpenAITool[];
  max_tokens?: number;
  temperature?: number;
}

type OpenAIMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };

interface OpenAIToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAITool {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface OpenAIChatResponse {
  choices: Array<{
    message: {
      role: 'assistant';
      content: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason: string;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export class OpenAIClient implements LLMClient {
  readonly name = 'openai';

  constructor(private readonly opts: OpenAIClientOptions) {}

  async complete(req: LLMRequest): Promise<AssistantTurn> {
    const apiKey = this.opts.apiKey ?? process.env.GROQ_API_KEY;
    if (!apiKey) {
      throw new Error('OpenAIClient: no API key. Pass apiKey or set GROQ_API_KEY env var.');
    }

    const messages = this.translateHistory(req.system, req.history);
    const tools = req.tools.length > 0 ? req.tools.map(toOpenAITool) : undefined;

    const model =
      req.model && req.model !== 'unset'
        ? req.model
        : (this.opts.defaultModel ?? 'meta-llama/llama-4-scout-17b-16e-instruct');

    const payload: OpenAIChatRequest = {
      model,
      messages,
      tools,
      max_tokens: req.maxTokens,
    };

    const baseUrl = this.opts.baseUrl.replace(/\/$/, '');
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OpenAI-compat HTTP ${res.status} ${res.statusText}: ${body.slice(0, 500)}`);
    }

    const json = (await res.json()) as OpenAIChatResponse;
    const msg = json.choices[0]?.message;

    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      input: safeParseJson(tc.function.arguments),
    }));

    const stopReason: AssistantTurn['stopReason'] =
      toolCalls.length > 0
        ? 'tool_use'
        : json.choices[0]?.finish_reason === 'length'
          ? 'max_tokens'
          : 'end_turn';

    return {
      text: msg?.content ?? undefined,
      toolCalls,
      stopReason,
      usage: {
        inputTokens: json.usage?.prompt_tokens ?? 0,
        outputTokens: json.usage?.completion_tokens ?? 0,
      },
    };
  }

  private translateHistory(system: string, history: Turn[]): OpenAIMessage[] {
    const out: OpenAIMessage[] = [{ role: 'system', content: system }];

    for (const turn of history) {
      if (turn.role === 'user') {
        for (const r of turn.content.toolResults) {
          out.push({
            role: 'tool',
            tool_call_id: r.id,
            content: stringifyToolOutput(r),
          });
        }
        if (turn.content.text) {
          out.push({ role: 'user', content: turn.content.text });
        }
        continue;
      }

      const a = turn.content;
      const openAIToolCalls: OpenAIToolCall[] = a.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input ?? {}),
        },
      }));

      out.push({
        role: 'assistant',
        content: a.text ?? null,
        ...(openAIToolCalls.length > 0 ? { tool_calls: openAIToolCalls } : {}),
      });
    }

    return out;
  }
}

function toOpenAITool(spec: ToolSpec): OpenAITool {
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
  if (!r.ok) return JSON.stringify({ ok: false, error: r.error ?? 'unknown error' });
  return JSON.stringify({ ok: true, output: r.output });
}

function safeParseJson(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
    return { value: v };
  } catch {
    return { raw: s };
  }
}
