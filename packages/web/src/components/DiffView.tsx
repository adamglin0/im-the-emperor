// 行级 diff 展示（并排标记 +/-）
import { useMemo } from "react";
import { diffLines, diffStats } from "../lib/diff.ts";

export function DiffView({ before, after, labels = ["旧", "新"], maxHeight = 520 }: { before: string; after: string; labels?: [string, string]; maxHeight?: number }) {
  const ops = useMemo(() => diffLines(before ?? "", after ?? ""), [before, after]);
  const st = diffStats(ops);
  return (
    <div className="diff">
      <div className="diff-head small">
        <span className="tag red">− {labels[0]} {st.del} 行</span>
        <span className="tag jade">＋ {labels[1]} {st.add} 行</span>
      </div>
      <div className="diff-body" style={{ maxHeight }}>
        {ops.map((o, i) => (
          <div key={i} className={`diff-line ${o.op}`}>
            <span className="ln">{o.a ?? ""}</span>
            <span className="ln">{o.b ?? ""}</span>
            <span className="mk">{o.op === "add" ? "+" : o.op === "del" ? "−" : " "}</span>
            <span className="tx">{o.text || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
