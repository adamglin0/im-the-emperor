// 简单行级 diff（LCS）。用于草稿版本、配置历史对比。
export type DiffOp = { op: "eq" | "add" | "del"; text: string; a?: number; b?: number };

export function diffLines(oldText: string, newText: string): DiffOp[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  // 体量过大时退化为整段替换，避免 O(nm) 爆内存
  if (n * m > 4_000_000) {
    return [...a.map((t, i) => ({ op: "del" as const, text: t, a: i + 1 })), ...b.map((t, j) => ({ op: "add" as const, text: t, b: j + 1 }))];
  }
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: "eq", text: a[i], a: i + 1, b: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: "del", text: a[i], a: i + 1 });
      i++;
    } else {
      out.push({ op: "add", text: b[j], b: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ op: "del", text: a[i], a: ++i });
  while (j < m) out.push({ op: "add", text: b[j], b: ++j });
  return out;
}

export function diffStats(ops: DiffOp[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const o of ops) {
    if (o.op === "add") add++;
    else if (o.op === "del") del++;
  }
  return { add, del };
}
