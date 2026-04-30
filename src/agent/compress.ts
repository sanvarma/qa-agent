import type { Turn, ToolResult } from './types.js';

// Tools whose text output contains a large ARIA/snapshot blob.
const BROWSE_TOOLS = new Set([
  'browse.navigate',
  'browse.snapshot',
  'browse.click',
  'browse.type',
  'browse.hover',
]);

// Verbose output fields that are useful when first received but wasteful in
// accumulated history. The LLM's own text reasoning captures the key takeaways.
const STRIP_FIELDS = new Set(['contents', 'diff', 'code', 'testCode', 'rawOutput']);

function compressOne(result: ToolResult): ToolResult {
  if (!result.ok || result.output === null || result.output === undefined) return result;
  const name = result.toolName;

  // Browse tools: strip the ARIA snapshot blob; keep the header lines
  // (Ran code / Page URL / Page Title) so the LLM can recall which page was visited.
  if (name && BROWSE_TOOLS.has(name)) {
    const out = result.output as { content?: Array<{ type: string; text?: string }> };
    if (Array.isArray(out.content)) {
      const compressed = out.content.map(block => {
        if (block.type !== 'text' || !block.text) return block;
        const snapIdx = block.text.indexOf('- Page Snapshot');
        if (snapIdx === -1) return block;
        const header = block.text.slice(0, snapIdx).trimEnd();
        return { ...block, text: `${header}\n[snapshot omitted — was processed when received]` };
      });
      return { ...result, output: { ...out, content: compressed } };
    }
  }

  // fs.read: truncate file content so large files don't accumulate across turns.
  // 40 lines is enough for the LLM to recall what it saw; it can re-read if needed.
  if (name === 'fs.read') {
    const out = result.output as Record<string, unknown>;
    if (typeof out.content === 'string') {
      const lines = (out.content as string).split('\n');
      const MAX = 40;
      if (lines.length > MAX) {
        return {
          ...result,
          output: {
            ...out,
            content:
              lines.slice(0, MAX).join('\n') +
              `\n[...${lines.length - MAX} lines omitted from history — re-read if needed]`,
          },
        };
      }
    }
  }

  // Write tools (createPage, updateSelector, addCase, etc.): strip verbose
  // output fields. The LLM's text response already captured what changed.
  if (typeof result.output === 'object') {
    const out = result.output as Record<string, unknown>;
    const stripped = Object.fromEntries(
      Object.entries(out).filter(([k]) => !STRIP_FIELDS.has(k)),
    );
    if (Object.keys(stripped).length < Object.keys(out).length) {
      return { ...result, output: stripped };
    }
  }

  return result;
}

/**
 * Return a compressed view of the conversation history for the LLM.
 * The most-recent tool-result batch is kept at full fidelity so the LLM can
 * act on it. All older batches are compressed: snapshot blobs stripped, file
 * content truncated, verbose write-output fields removed.
 *
 * The raw `state.turns` log is never mutated — this only affects what is sent
 * to the LLM on each call.
 */
export function compressHistoryForLLM(turns: Turn[]): Turn[] {
  // Locate the last user turn that carries tool results.
  let lastIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role === 'user' && t.content.toolResults && t.content.toolResults.length > 0) {
      lastIdx = i;
      break;
    }
  }

  return turns.map((turn, i) => {
    if (turn.role !== 'user') return turn;
    const results = turn.content.toolResults;
    if (!results || results.length === 0) return turn;
    // Most-recent batch: pass through unmodified.
    if (i === lastIdx) return turn;
    // Older batches: compress each result.
    return {
      ...turn,
      content: { ...turn.content, toolResults: results.map(compressOne) },
    };
  });
}
