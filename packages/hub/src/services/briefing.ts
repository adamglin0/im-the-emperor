// 醒来简报：新消息 + 结构化职事清单（PendingItem），按优先级排列，最多 K 条。
// 优先级：陛下批复与陛下来信 → 议事 → 诏令 → 任务（承办/核验）→ 服务请求 → 定时任务 → 稽查 → 阅卷 → 其他来信。
import { LIMITS, type Briefing, type InboxItem, type MessageKind, type PendingItem } from "@court/shared";
import { notFound, type BriefingService, type HubCtx } from "../ctx.ts";
import { createFlowEnv } from "./workflow-env.ts";
import { isTaskTerminal } from "./workflow-store.ts";

/** 由结构化职事表示的消息类别：不再作为普通来信重复列出 */
const STRUCTURAL_KINDS: ReadonlySet<MessageKind> = new Set(["edict_notice", "task_notice", "service_request", "council", "schedule", "notification_reply"]);
/** 新信扫描窗口 = 部门 runtime 每轮渲染并确认的新信条数（runtime 只 ack 到第 K 封），两边一致才不会漏办/重办 */
const MAX_INBOX_SCAN = LIMITS.briefingMaxItems;
/** 新信占满窗口时仍保留给结构化职事的最少条数 */
const MIN_STRUCTURAL_SLOTS = 4;
const MAX_AUDIT_ITEMS = 3;
const MAX_GRADING_ITEMS = 3;

export function createBriefing(ctx: HubCtx): BriefingService {
  const env = createFlowEnv(ctx);
  const { store } = env;
  const reg = () => ctx.registry;

  function councilItems(post: string): PendingItem[] {
    const out: PendingItem[] = [];
    for (const d of store.listDeliberations("open", 50)) {
      if (d.current_speaker === post) out.push({ type: "council_turn", deliberation_id: d.id, round: d.round, topic: d.topic });
      else if (d.chair_post === post && !d.current_speaker && d.speaker_queue.length === 0) {
        out.push({ type: "council_chair", deliberation_id: d.id, round: d.round, all_spoken: true, topic: d.topic });
      }
    }
    return out;
  }

  function edictItems(post: string): PendingItem[] {
    const out: PendingItem[] = [];
    const def = reg().post(post);
    // 与 countersign 的权限一致：中书省 head/deputy 且持有复署工具
    const isCountersigner = def?.dept === "zhongshu" && (def.roles.includes("head") || def.roles.includes("deputy")) && reg().hasTool(post, "edict_countersign");
    for (const e of store.listEdictsInStates(["drafting", "reviewing", "approved", "executing"])) {
      if (e.state === "drafting") {
        if (e.awaiting_countersign) {
          if (isCountersigner) out.push({ type: "edict_countersign", edict_id: e.id, title: e.title, draft_no: e.draft_no });
        } else if (e.drafter_post === post) {
          const reviews = store.listReviews(e.id).filter((r) => r.draft_no >= (e.review_baseline ?? 0));
          const last = reviews[reviews.length - 1];
          const rejected = !!last && last.decision === "reject" && last.draft_no === e.draft_no;
          out.push({
            type: "edict_draft",
            edict_id: e.id,
            title: e.title,
            draft_no_next: e.draft_no + 1,
            rejected,
            open_issue_ids: rejected ? last.issues.filter((i) => i.severity === "blocking").map((i) => i.id) : [],
          });
        }
      } else if (e.state === "reviewing" && e.reviewer_post === post) {
        const prior = store
          .listReviews(e.id)
          .filter((r) => r.draft_no >= (e.review_baseline ?? 0))
          .flatMap((r) => r.issues.map((i) => i.id));
        out.push({ type: "edict_review", edict_id: e.id, title: e.title, draft_no: e.draft_no, prior_issue_ids: prior });
      } else if (e.state === "approved" && e.dispatcher_post === post) {
        out.push({ type: "edict_dispatch", edict_id: e.id, title: e.title, suggested_depts: store.getLatestDraftOrNull(e.id)?.suggested_depts ?? [] });
      } else if (e.state === "executing" && e.dispatcher_post === post && e.awaiting_redispatch) {
        // 复奏被发回重办：先追加分派（也可直接重新复奏）
        out.push({ type: "edict_dispatch", edict_id: e.id, title: e.title, suggested_depts: store.getLatestDraftOrNull(e.id)?.suggested_depts ?? [] });
      } else if (e.state === "executing" && e.dispatcher_post === post) {
        const roots = store.listRootTasksOfEdict(e.id);
        const open = roots.filter((t) => !isTaskTerminal(t.state)).length;
        if (roots.length && open === 0) out.push({ type: "edict_report", edict_id: e.id, title: e.title, tasks_total: roots.length, tasks_open: 0 });
      }
    }
    return out;
  }

  function taskItems(post: string): PendingItem[] {
    const out: PendingItem[] = [];
    const def = reg().post(post);
    for (const t of store.listOpenTasksOfAssignee(post)) {
      if (t.state !== "assigned" && t.state !== "in_progress" && t.state !== "returned") continue;
      const isHead = !!def && def.dept === t.dept && def.roles.includes("head") && !t.delegated;
      out.push({ type: "task_assigned", task_id: t.id, title: t.title, state: t.state, is_head: isHead });
    }
    const verify = ctx.db.allJson<{ id: string; title: string }>(
      "SELECT data_json FROM tasks WHERE state = 'submitted' AND json_extract(data_json, '$.verifier_post') = ? ORDER BY updated_at LIMIT 50",
      post,
    );
    for (const t of verify) out.push({ type: "task_verify", task_id: t.id, title: t.title });
    return out;
  }

  function serviceItems(post: string): PendingItem[] {
    return store.listPendingServiceRequests(post).map((r) => ({ type: "service_request", request_id: r.id, service: r.service, caller: r.caller }));
  }

  /** 稽查发现只派给巡察御史（role patrol）；无巡察御史时派给全体有稽查工具者 */
  function auditItems(post: string): PendingItem[] {
    const def = reg().post(post);
    if (!def || def.dept !== "yushitai" || !reg().hasTool(post, "audit_findings")) return [];
    const hasPatrol = reg()
      .posts("yushitai")
      .some((p) => p.roles.includes("patrol"));
    if (hasPatrol && !def.roles.includes("patrol")) return [];
    const rows = ctx.db.all<{ id: string; rule: string; subject: string }>(
      "SELECT id, rule, subject FROM audit_findings WHERE status = 'open' ORDER BY created_at LIMIT ?",
      MAX_AUDIT_ITEMS,
    );
    return rows.map((r) => ({ type: "audit_finding", finding_id: r.id, rule: r.rule, subject: r.subject }));
  }

  function gradingItems(post: string): PendingItem[] {
    if (!env.hasRole(post, "grader") || !reg().hasTool(post, "exam_grade")) return [];
    // 只列可阅的卷：场次未终结（已作废/考毕的卷 exam_grade 会报错）；阅卷官模型不评同模型考生（避免自评）
    const model = reg().officialOf(post)?.model ?? "";
    const rows = ctx.db.all<{ id: string; session_id: string }>(
      `SELECT a.id, a.session_id FROM exam_answers a JOIN exam_sessions s ON s.id = a.session_id
       WHERE a.state = 'needs_grading' AND s.state IN ('pending','running','grading') AND s.model_key != ? ORDER BY a.rowid LIMIT ?`,
      model,
      MAX_GRADING_ITEMS,
    );
    return rows.map((r) => ({ type: "exam_grading", answer_id: r.id, session_id: r.session_id }));
  }

  function structural(post: string): PendingItem[] {
    return [...councilItems(post), ...edictItems(post), ...taskItems(post), ...serviceItems(post), ...auditItems(post), ...gradingItems(post)];
  }

  function messageItem(i: InboxItem): PendingItem {
    const m = i.message;
    return { type: "message", message_id: m.id, from: m.from, kind: m.kind, subject: m.subject, requires_reply: m.requires_reply, trace_id: m.trace_id };
  }

  return {
    build(postId: string, after: number, wakeReason: string): Briefing {
      if (!reg().post(postId)) throw notFound(`职位 ${postId}`);
      const inbox = ctx.messages.inbox(postId, Math.max(0, Math.floor(after) || 0), MAX_INBOX_SCAN);
      const replies: PendingItem[] = [];
      const fromEmperor: PendingItem[] = [];
      const schedules: PendingItem[] = [];
      const others: PendingItem[] = [];
      for (const it of inbox.items) {
        const m = it.message;
        const meta = (m.meta ?? {}) as Record<string, unknown>;
        if (m.kind === "notification_reply") {
          replies.push({
            type: "notification_reply",
            notification_id: String(meta.notification_id ?? ""),
            option: String(meta.option ?? ""),
            comment: String(meta.comment ?? m.body),
          });
        } else if (m.kind === "schedule") {
          schedules.push({ type: "schedule", schedule_id: String(meta.schedule_id ?? ""), title: m.subject, payload: m.body });
        } else if (m.from === "emperor" && !STRUCTURAL_KINDS.has(m.kind)) {
          fromEmperor.push(messageItem(it));
        } else if (!STRUCTURAL_KINDS.has(m.kind)) {
          others.push(messageItem(it));
        }
      }
      const s = structural(postId);
      const byType = (t: PendingItem["type"]) => s.filter((x) => x.type === t);
      const max = LIMITS.briefingMaxItems;
      // 来信类职事（批复/陛下来信/定时/其他来信）一律列出：游标确认后它们不会再出现，截掉就永远漏办。
      // 结构化职事每次醒来都重新计算，截掉的下次还在，只占剩余名额。
      const msgCount = replies.length + fromEmperor.length + schedules.length + others.length;
      const structuralOrdered: PendingItem[] = [
        ...byType("council_chair"),
        ...byType("council_turn"),
        ...s.filter((x) => x.type.startsWith("edict_")),
        ...byType("task_assigned"),
        ...byType("task_verify"),
        ...byType("service_request"),
        ...byType("audit_finding"),
        ...byType("exam_grading"),
      ];
      const slots = Math.max(max - msgCount, MIN_STRUCTURAL_SLOTS);
      const kept = new Set(structuralOrdered.slice(0, slots));
      const keep = (xs: PendingItem[]) => xs.filter((x) => kept.has(x));
      const items: PendingItem[] = [
        ...replies,
        ...fromEmperor,
        ...keep(byType("council_chair")),
        ...keep(byType("council_turn")),
        ...keep(s.filter((x) => x.type.startsWith("edict_"))),
        ...keep(byType("task_assigned")),
        ...keep(byType("task_verify")),
        ...keep(byType("service_request")),
        ...schedules,
        ...keep(byType("audit_finding")),
        ...keep(byType("exam_grading")),
        ...others,
      ];
      // 新信超过扫描窗口时，latest_seq 只推进到已扫描的最后一条，余下的下次再看
      const truncated = inbox.items.length >= MAX_INBOX_SCAN;
      const latestSeq = truncated ? inbox.items[inbox.items.length - 1].delivery.seq : inbox.latest_seq;
      return {
        post_id: postId,
        generated_at: ctx.now(),
        wake_reason: wakeReason || "",
        items,
        more: Math.max(0, structuralOrdered.length - kept.size) + (truncated ? Math.max(0, inbox.latest_seq - latestSeq) : 0),
        latest_seq: latestSeq,
      };
    },

    pendingItems(postId: string): PendingItem[] {
      return structural(postId);
    },
  };
}
