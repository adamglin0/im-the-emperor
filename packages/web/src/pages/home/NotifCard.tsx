// 待办奏折卡：类别印、发起人、正文、相关链接、批复按钮 + 朱批（批语）
import { useState } from "react";
import { Link } from "react-router";
import type { Notification } from "@court/shared/types";
import { hub } from "../../api/client.ts";
import { Addr, TimeAgo } from "../../components/Addr.tsx";
import { Markdown } from "../../components/Markdown.tsx";
import { Seal } from "../../components/Seal.tsx";
import { Tag } from "../../components/Tag.tsx";
import { useAction } from "../../hooks/useAction.ts";
import { NOTIF_CATEGORY, type Tone } from "../../lib/labels.ts";

/** 批复选项 → 盖印字与色调 */
export function optionSeal(id: string, label: string): { text: string; tone: Tone } {
  const k = id.toLowerCase();
  if (/^(approve|force_approve|accept|insist|sign|ok|yes|confirm)$/.test(k)) return { text: "准", tone: "red" };
  if (/^(reject|dismiss|deny|no)$/.test(k)) return { text: "驳", tone: "ink" };
  if (k === "withdraw" || k === "cancel") return { text: "撤", tone: "ink" };
  if (/^(revise|rediscuss|reconvene|reopen|retry)$/.test(k)) return { text: "议", tone: "gold" };
  if (k === "shelve") return { text: "搁", tone: "ink" };
  if (/^(ack|read|ignore|keep)$/.test(k)) return { text: "阅", tone: "jade" };
  if (k === "reply") return { text: "答", tone: "red" };
  if (k === "urge") return { text: "督", tone: "red" };
  if (k.startsWith("to_")) return { text: "交", tone: "azure" };
  if (k === "raise") return { text: "增", tone: "gold" };
  return { text: label.slice(0, 1) || "批", tone: "red" };
}

/** 相关对象 → 路由 */
export function relatedHref(n: Notification): { href: string; label: string } | undefined {
  const r = n.related;
  if (r) {
    if (r.type === "edict") return { href: `/edicts/${r.id}`, label: "查看诏令" };
    if (r.type === "deliberation") return { href: `/council?id=${r.id}`, label: "入政事堂" };
    if (r.type === "impeachment" || r.type === "audit_finding") return { href: "/censor", label: "御史台" };
    if (r.type === "task" && n.trace_id) return { href: `/edicts/${n.trace_id}`, label: "查看诏令" };
    if (r.type === "approval") return { href: "/libu", label: "吏部审批" };
    if (r.type === "schedule") return { href: "/schedules", label: "定时任务" };
    if (r.type === "exam" || r.type === "exam_session" || r.type === "model") return { href: "/exams", label: "科举" };
    if (r.type === "budget_scope") return { href: "/ledger", label: "户部账本" };
  }
  if (n.trace_id) return { href: `/edicts/${n.trace_id}`, label: "追踪" };
  return undefined;
}

const URGENT = new Set(["escalation", "impeachment", "incident", "budget"]);

/** 知会类（fyi）或无选项的待办：hub 不给选项，以保留选项 dismiss（撤下）标为已阅 */
export const READ_OPTION = { id: "dismiss", label: "已阅" };
export function optionsOf(n: Pick<Notification, "options">): { id: string; label: string }[] {
  return n.options.length ? n.options : [READ_OPTION];
}

/** hub 要求朱批不得为空的选项：请旨「答复」（批语即答复内容）、诏令「修改旨意」 */
export function commentRequired(n: Pick<Notification, "category">, optId: string): boolean {
  if (optId === "reply") return true;
  return optId === "revise" && (n.category === "remonstrance" || n.category === "escalation" || n.category === "report");
}

/** onHold：批复成功即调用（父组件据此在盖印动画期间保留此卡）；onResolved：动画结束后调用 */
export function NotifCard({ n, onResolved, onHold }: { n: Notification; onResolved: () => void; onHold?: (n: Notification) => void }) {
  const cat = NOTIF_CATEGORY[n.category] ?? { label: n.category, seal: "奏", tone: "gold" as Tone };
  const [comment, setComment] = useState("");
  const [showComment, setShowComment] = useState(() => n.options.length > 0 && n.options.every((o) => commentRequired(n, o.id)));
  const [expanded, setExpanded] = useState(false);
  const [stamped, setStamped] = useState<{ text: string; tone: Tone } | null>(null);
  const { run, pending } = useAction();
  const rel = relatedHref(n);
  const long = (n.body ?? "").length > 140 || (n.body ?? "").split("\n").length > 4;

  const [needNote, setNeedNote] = useState(false);
  const resolve = async (optId: string, label: string) => {
    if (commentRequired(n, optId) && !comment.trim()) {
      setShowComment(true);
      setNeedNote(true);
      return;
    }
    const r = await run(() => hub.resolveNotification(n.id, { option: optId, comment: comment.trim() || undefined }));
    if (!r) return;
    setStamped(n.options.length ? optionSeal(optId, label) : { text: "阅", tone: "jade" });
    onHold?.(n);
    setTimeout(onResolved, 1300);
  };

  return (
    <article className={`card memorial notif ${URGENT.has(n.category) ? "urgent" : ""} ${pending ? "resolving" : ""} ${stamped ? "leaving" : ""}`}>
      <div className="notif-head">
        <Seal text={cat.seal} tone={cat.tone} size={34} />
        <div className="grow">
          <div className="notif-title">{n.title}</div>
          <div className="notif-meta">
            <Tag tone={cat.tone}>{cat.label}</Tag>
            {n.kind === "fyi" && <Tag outline>知会</Tag>}
            <span>
              来自 <Addr a={n.from} />
            </span>
            <span>·</span>
            <TimeAgo ms={n.created_at} />
            {rel && (
              <Link to={rel.href} style={{ marginLeft: "auto" }}>
                {rel.label} →
              </Link>
            )}
          </div>
        </div>
      </div>
      {n.body && (
        <>
          <div className={`notif-body ${long && !expanded ? "collapsed" : ""}`}>
            <Markdown text={n.body} />
          </div>
          {long && (
            <button className="btn ghost sm" style={{ marginLeft: 40 }} onClick={() => setExpanded(!expanded)}>
              {expanded ? "收起" : "展开全文"}
            </button>
          )}
        </>
      )}
      {!stamped && n.status === "pending" && (
        <div className="notif-actions">
          {showComment && (
            <textarea
              placeholder={needNote ? "请先写下朱批（此项须写明圣意，批语即回复内容）" : "朱批（可选）：陛下的批语将回写给上奏者"}
              value={comment}
              onChange={(e) => {
                setComment(e.target.value);
                setNeedNote(false);
              }}
              autoFocus
              aria-invalid={needNote || undefined}
            />
          )}
          <div className="btn-row">
            {optionsOf(n).map((o, i) => (
              <button key={o.id} className={`btn ${i === 0 ? "primary" : ""}`} disabled={pending} onClick={() => resolve(o.id, o.label)}>
                {o.label}
              </button>
            ))}
            {!showComment && (
              <button className="btn ghost sm" onClick={() => setShowComment(true)}>
                ✎ 加朱批
              </button>
            )}
          </div>
        </div>
      )}
      {stamped && (
        <div className="stamp-overlay">
          <Seal text={stamped.text} tone={stamped.tone} size={72} stamp solid={stamped.tone === "red"} rotate={-12} />
        </div>
      )}
    </article>
  );
}
