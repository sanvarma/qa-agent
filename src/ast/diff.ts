// Tiny unified-diff formatter. Intentionally NOT a patch format consumer —
// this exists solely to give the LLM a bounded, human-readable view of what
// a mutating tool changed. Cap prevents context blow-up on large rewrites.

const MAX_BYTES = 4 * 1024;

export function unifiedDiff(before: string, after: string, fileLabel: string): string {
  if (before === after) return '';

  const a = before.split('\n');
  const b = after.split('\n');

  // LCS table for small-to-medium files. O(n*m) memory is fine here;
  // ts-morph edits touch one function body and this op is bounded by file size.
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const ops: Array<{ op: ' ' | '-' | '+'; line: string }> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: ' ', line: a[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: '-', line: a[i] });
      i++;
    } else {
      ops.push({ op: '+', line: b[j] });
      j++;
    }
  }
  while (i < n) ops.push({ op: '-', line: a[i++] });
  while (j < m) ops.push({ op: '+', line: b[j++] });

  const header = `--- a/${fileLabel}\n+++ b/${fileLabel}\n`;
  const body = ops.map((o) => `${o.op}${o.line}`).join('\n');
  const out = header + body;
  return out.length > MAX_BYTES ? out.slice(0, MAX_BYTES) + '\n... [diff truncated]' : out;
}
