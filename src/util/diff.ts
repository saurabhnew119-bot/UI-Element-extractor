/** Unified diff of two texts (line based, LCS). Adequate for page-object sized files. */
export function unifiedDiff(a: string, b: string, fileA: string, fileB: string, context = 3): string {
  const x = a.split('\n');
  const y = b.split('\n');
  if (x.length * y.length > 25_000_000) return `--- ${fileA}\n+++ ${fileB}\n@@ file too large to diff inline @@\n`;
  const n = x.length;
  const m = y.length;
  const lcs: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  type Op = { t: ' ' | '-' | '+'; line: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && x[i] === y[j]) ops.push({ t: ' ', line: x[i], ai: i++, bi: j++ });
    else if (i < n && (j >= m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push({ t: '-', line: x[i], ai: i++, bi: j });
    else ops.push({ t: '+', line: y[j], ai: i, bi: j++ });
  }
  const out = [`--- ${fileA}`, `+++ ${fileB}`];
  const changed = ops.flatMap((o, idx) => (o.t === ' ' ? [] : [idx]));
  // Group changes whose unchanged gap is small enough that their context windows would overlap.
  const groups: number[][] = [];
  for (const idx of changed) {
    const g = groups[groups.length - 1];
    if (g && idx - g[g.length - 1] <= context * 2 + 1) g.push(idx);
    else groups.push([idx]);
  }
  for (const g of groups) {
    const hunk = ops.slice(Math.max(0, g[0] - context), Math.min(ops.length, g[g.length - 1] + context + 1));
    const aLen = hunk.filter((o) => o.t !== '+').length;
    const bLen = hunk.filter((o) => o.t !== '-').length;
    out.push(`@@ -${hunk[0].ai + 1},${aLen} +${hunk[0].bi + 1},${bLen} @@`);
    for (const o of hunk) out.push(o.t + o.line);
  }
  return out.length === 2 ? '' : out.join('\n') + '\n';
}
