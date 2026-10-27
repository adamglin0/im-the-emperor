// 诏令阶段进度：起草→审核→分派→执行→复奏→完成；封驳循环以回环标记显示
import type { Edict } from "@court/shared/types";
import { EDICT_STAGES, edictStageIndex } from "../lib/labels.ts";

export function StageBar({ edict, compact }: { edict: Pick<Edict, "state" | "reject_count" | "remonstrated_draft_nos" | "skip_review">; compact?: boolean }) {
  const idx = edictStageIndex(edict.state);
  const failed = idx < 0;
  const blocked = edict.state === "blocked_budget" || edict.state === "escalated" || edict.state === "remonstrated";
  return (
    <div className={`stagebar ${compact ? "compact" : ""} ${failed ? "failed" : ""}`} aria-label="诏令阶段">
      {EDICT_STAGES.map((s, i) => {
        const cls = failed ? "dead" : i < idx ? "done" : i === idx ? (blocked ? "blocked" : edict.state === "completed" ? "done" : "now") : "todo";
        return (
          <div key={s} className={`stage ${cls}`}>
            <div className="stage-bar" />
            <div className="stage-label">
              {s}
              {i === 1 && edict.reject_count > 0 && (
                <span className="loop" title={`封驳 ${edict.reject_count} 次，退回中书重拟`}>
                  ↺驳×{edict.reject_count}
                </span>
              )}
              {i === 1 && edict.skip_review && <span className="loop ink" title="墨敕：绕过门下">墨敕</span>}
              {i === 1 && (edict.remonstrated_draft_nos?.length ?? 0) > 0 && <span className="loop plum">谏</span>}
            </div>
          </div>
        );
      })}
    </div>
  );
}
