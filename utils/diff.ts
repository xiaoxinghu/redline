// diff.ts — the word-level diff shared by the panel UI and the export preview.
//
// Kept in sync with engine.ts. `diffParts` returns merged runs tagged with an
// op; the UI renders them as <ins>/<del>, and the export turns them into a
// `[+...]`/`[-...]` text preview.

export type DiffOp = '=' | '+' | '-';
export interface DiffPart {
  op: DiffOp;
  text: string;
}

function tokenize(s: string): string[] {
  return (s || '').match(/(\s+|[^\s]+)/g) || [];
}

export function diffParts(original: string, edited: string): DiffPart[] {
  const a = tokenize(original);
  const b = tokenize(edited);
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    const out: DiffPart[] = [];
    if (n) out.push({ op: '-', text: a.join('') });
    if (m) out.push({ op: '+', text: b.join('') });
    return out;
  }
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const raw: DiffPart[] = [];
  let i = 0,
    j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ op: '=', text: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { raw.push({ op: '-', text: a[i] }); i++; }
    else { raw.push({ op: '+', text: b[j] }); j++; }
  }
  while (i < n) raw.push({ op: '-', text: a[i++] });
  while (j < m) raw.push({ op: '+', text: b[j++] });
  const merged: DiffPart[] = [];
  for (const p of raw) {
    const last = merged[merged.length - 1];
    if (last && last.op === p.op) last.text += p.text;
    else merged.push({ ...p });
  }
  return merged;
}

export function diffPreview(original: string, edited: string): string {
  return diffParts(original, edited)
    .map((p) => (p.op === '=' ? p.text : p.op === '+' ? `[+${p.text}]` : `[-${p.text}]`))
    .join('');
}
