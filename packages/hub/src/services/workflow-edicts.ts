// 诏令状态机：issued → drafting → reviewing → approved → executing → reported → completed
// 旁路：封驳回 drafting（超限 escalated）、谏诤 remonstrated、覆奏 awaiting_sign、撤回 withdrawn、failed、blocked_budget。
import {
  LIMITS,
  SLA,
  newId,
  type Address,
  type DispatchTaskSpec,
  type EdictDetail,
  type EdictDraft,
  type EdictReview,
  type EdictState,
  type EmperorEdictActionReq,
  type Notification,
  type ReviewIssue,
} from "@court/shared";
import { bad, forbidden, invalidState, versionConflict } from "../ctx.ts";
import { checkVersion, clip, postAddress } from "./flow-util.ts";
import type { FlowEnv } from "./workflow-env.ts";
import { isEdictTerminal, isTaskTerminal, type EdictRow } from "./workflow-store.ts";
import { isEmperorActor, type FlowActor, type TaskFlow } from "./workflow-tasks.ts";

export interface IssueEdictInput {
  title: string;
  intent: string;
  deliberation_id?: string;
  skip_review?: boolean;
  budget_tokens?: number;
  deadline_minutes?: number;
  actor: Address;
}

export interface DraftInput {
  title: string;
  objective: string;
  constraints: string;
  acceptance: string;
  deadline_text: string;
  budget_tokens?: number;
  suggested_depts: EdictDraft["suggested_depts"];
  text: string;
  responses: { issue_id: string; response: string }[];
  expected_version?: number;
}

export interface ReviewInput {
  decision: "approve" | "reject";
  issues: Omit<ReviewIssue, "id">[];
  opinion: string;
  expected_version?: number;
}

/** 皇帝动作（含内部用的 reopen / sign） */
export type EdictAction = EmperorEdictActionReq["action"] | "reopen" | "sign";

/** 皇帝批复后需要关闭的、与诏令相关的待办类别 */
const EDICT_NOTICE_CATEGORIES = ["remonstrance", "escalation", "report", "clarification"] as const;

export const edictSpanId = (edictId: string) => `sp_${edictId}`;

export function createEdictFlow(env: FlowEnv, tasks: TaskFlow) {
  const { ctx, store } = env;
  const reg = () => ctx.registry;

  // ── 基础 ──
  function slaAt(e: EdictRow, state: EdictState, now: number): number | undefined {
    switch (state) {
      case "drafting":
        return now + SLA.edict_drafting * 1000;
      case "reviewing":
        return now + SLA.edict_reviewing * 1000;
      case "approved":
        return now + SLA.edict_approved * 1000;
      case "executing":
        // 期限已过（如起草审核耗时过长、发回重办）时按默认时限重新起算，避免一进入执行就越级上报
        return e.deadline && e.deadline > now ? e.deadline : now + SLA.edict_executing_default * 1000;
      default:
        return undefined;
    }
  }

  function setState(e: EdictRow, to: EdictState, actor: Address, reason: string): void {
    const now = env.now();
    const from = e.state;
    e.state = to;
    e.state_entered_at = now;
    e.sla_at = slaAt(e, to, now);
    e.lease_until = undefined;
    ctx.transition("edict", e.id, from, to, actor, reason, e.id);
    // 阶段已变，旧阶段的超期上报（皇帝待办）随之作废
    store.dismissPendingNotifications(e.id, ["escalation"]);
  }

  /** 中书复署人：侍郎（head），缺则 deputy */
  function countersigner(): string | undefined {
    return reg().pickPost("zhongshu", ["head"]) ?? reg().pickPost("zhongshu", ["deputy"]);
  }

  /** 当前阶段已自动知会谁（写入接口响应 note，免得官员再另行发信） */
  function stageNote(e: EdictRow): string {
    const who = (p: string | undefined, role: string) => (p ? `${role} ${p}` : `${role}（暂缺，看门狗将改派）`);
    switch (e.state) {
      case "drafting":
        return e.awaiting_countersign ? `已自动通知${who(countersigner(), "中书侍郎")}复署，无需另行发信` : `已自动通知${who(e.drafter_post, "起草舍人")}起草，无需另行发信`;
      case "reviewing":
        return `已自动送门下，通知${who(e.reviewer_post, "主审给事中")}审核，无需另行发信`;
      case "approved":
        return `已自动交尚书省，通知${who(e.dispatcher_post, "分派官")}分派，无需另行发信`;
      case "executing": {
        const open = store.listRootTasksOfEdict(e.id).filter((t) => !isTaskTerminal(t.state));
        return `已自动通知各承办人：${open.map((t) => `${t.dept}→${t.assignee_post ?? "待指派"}`).join("、") || "（无未结任务）"}，无需另行发信`;
      }
      case "escalated":
      case "awaiting_sign":
      case "remonstrated":
      case "reported":
        return "已自动奏请陛下定夺，无需另行上奏";
      default:
        return `诏令当前状态：${e.state}`;
    }
  }

  function requireState(e: EdictRow, allowed: EdictState[], action: string): void {
    if (!allowed.includes(e.state)) {
      throw invalidState(`诏令 ${e.id} 当前状态为「${e.state}」，不能执行 ${action}；允许的状态：${allowed.join(" / ")}`);
    }
  }

  function isDeptRole(post: string | undefined, dept: string, roles: string[]): boolean {
    if (!post) return false;
    const p = reg().post(post);
    return !!p && p.dept === dept && roles.some((r) => p.roles.includes(r));
  }

  function notifyEdict(post: string | undefined, e: EdictRow, subject: string, body: string, wakes = true): void {
    env.notify(post, "edict_notice", subject, body, { trace_id: e.id, wakes, meta: { edict_id: e.id } });
  }

  function notifyYushitai(e: EdictRow, subject: string, body: string): void {
    const post = reg().routeDept("yushitai", "fyi");
    env.notify(post, "fyi", subject, body, { trace_id: e.id, wakes: false, meta: { edict_id: e.id } });
  }

  function reviewsSinceBaseline(e: EdictRow): EdictReview[] {
    const base = e.review_baseline ?? 0;
    return store.listReviews(e.id).filter((r) => r.draft_no >= base);
  }

  /** 最近一次封驳（针对当前稿）中尚待回应的 blocking 问题 */
  function openBlockingIssues(e: EdictRow): ReviewIssue[] {
    const reviews = reviewsSinceBaseline(e);
    const last = reviews[reviews.length - 1];
    if (!last || last.decision !== "reject" || last.draft_no !== e.draft_no) return [];
    return last.issues.filter((i) => i.severity === "blocking");
  }

  function priorIssues(e: EdictRow): ReviewIssue[] {
    return reviewsSinceBaseline(e).flatMap((r) => r.issues);
  }

  function renderDraft(d: EdictDraft | undefined): string {
    if (!d) return "（尚无草稿）";
    return [
      `第 ${d.no} 稿（${d.author_post}${d.countersigned_by ? `，${d.countersigned_by} 复署` : ""}）`,
      `标题：${d.title}`,
      `目标：${clip(d.objective, 1500)}`,
      `约束：${clip(d.constraints, 800)}`,
      `验收标准：${clip(d.acceptance, 1000)}`,
      `期限：${d.deadline_text}`,
      d.budget_tokens ? `预算上限：${d.budget_tokens} tokens` : "",
      `建议承办部门：${d.suggested_depts.join("、") || "（未写）"}`,
      `正文：\n${clip(d.text, 3000)}`,
      d.responses.length ? `对封驳的回应：\n${d.responses.map((r) => `- ${r.issue_id}：${clip(r.response, 300)}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  function renderIssues(issues: ReviewIssue[]): string {
    return issues.map((i) => `- ${i.id} [${i.severity}] 条款：${i.clause}；理由：${i.reason}；须改：${i.required_change}`).join("\n");
  }

  function draftingBrief(e: EdictRow, note?: string): string {
    const open = openBlockingIssues(e);
    return [
      `诏令 ${e.id}「${e.title}」`,
      `旨意：${clip(e.intent, 3000)}`,
      e.deadline ? `期限：${new Date(e.deadline).toISOString()}` : "",
      e.budget_tokens ? `预算：${e.budget_tokens} tokens` : "",
      note ? `说明：${note}` : "",
      open.length ? `门下封驳的 blocking 问题（第 ${e.reject_count} 次封驳，须在 responses 中逐条回应）：\n${renderIssues(open)}` : "",
      `请起草诏书（edict_submit_draft，下一稿为第 ${e.draft_no + 1} 稿），写明目标、约束、验收标准、期限、预算上限、建议承办部门。`,
    ]
      .filter(Boolean)
      .join("\n");
  }

  function reviewBrief(e: EdictRow): string {
    const prior = priorIssues(e);
    return [
      `诏令 ${e.id}「${e.title}」待门下审核。`,
      `旨意：${clip(e.intent, 1500)}`,
      renderDraft(store.getLatestDraftOrNull(e.id)),
      prior.length
        ? `前次审核提出的问题（本次只能核对这些问题是否改好，不得新增 blocking；blocking 的 clause 须引用其编号）：\n${renderIssues(prior)}`
        : "",
      `请用 edict_review 给出结论：approve，或 reject（至少 1 条 blocking，理由须出自：违法越权/不可行/超预算/表述不清/与前诏冲突/缺验收标准）。`,
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  function dispatchBrief(e: EdictRow): string {
    const d = store.getLatestDraftOrNull(e.id);
    return [
      `诏令 ${e.id}「${e.title}」已获准，待尚书省分派。`,
      `旨意：${clip(e.intent, 1500)}`,
      renderDraft(d),
      `请用 edict_dispatch 把诏令拆成各部任务（写明承办部、要求、验收标准、期限、由谁核验）。`,
    ].join("\n\n");
  }

  function stageBrief(e: EdictRow): string {
    if (e.state === "reviewing") return reviewBrief(e);
    if (e.state === "approved") return dispatchBrief(e);
    return draftingBrief(e);
  }

  // ── 阶段进入 ──
  function enterDrafting(e: EdictRow, actor: Address, reason: string, note?: string): void {
    if (!e.drafter_post) e.drafter_post = reg().pickPost("zhongshu", ["drafter"]);
    e.awaiting_countersign = false;
    setState(e, "drafting", actor, reason);
    e.lease_until = env.now() + SLA.lease * 1000;
    notifyEdict(e.drafter_post, e, e.draft_no ? `诏令需重拟：${e.title}` : `起草诏令：${e.title}`, draftingBrief(e, note));
  }

  function enterReviewing(e: EdictRow, actor: Address, reason: string): void {
    if (e.skip_review) {
      enterApproved(e, actor, `${reason}；墨敕免门下审核`);
      notifyYushitai(e, `墨敕留痕：${e.title}`, `诏令 ${e.id}「${e.title}」奉墨敕免门下审核，直接交尚书省执行。请御史台留档备查。`);
      return;
    }
    if (!e.reviewer_post) e.reviewer_post = reg().pickPost("menxia", ["reviewer"]);
    setState(e, "reviewing", actor, reason);
    e.lease_until = env.now() + SLA.lease * 1000;
    notifyEdict(e.reviewer_post, e, `审核诏令：${e.title}（第 ${e.draft_no} 稿）`, reviewBrief(e));
  }

  function enterApproved(e: EdictRow, actor: Address, reason: string): void {
    if (!e.dispatcher_post) e.dispatcher_post = reg().pickPost("shangshu", ["dispatcher"]);
    setState(e, "approved", actor, reason);
    e.lease_until = env.now() + SLA.lease * 1000;
    notifyEdict(e.dispatcher_post, e, `分派诏令：${e.title}`, dispatchBrief(e));
  }

  function withdraw(e: EdictRow, actor: Address, reason: string): void {
    setState(e, "withdrawn", actor, reason);
    const n = tasks.cancelOpenTasksOfEdict(e.id, actor, `诏令撤回：${reason}`);
    ctx.events.endSpan(edictSpanId(e.id), "cancelled", { reason, cancelled_tasks: n });
    for (const p of new Set([e.drafter_post, e.reviewer_post, e.dispatcher_post])) {
      notifyEdict(p, e, `诏令已撤回：${e.title}`, `诏令 ${e.id} 已撤回（${reason}），相关工作停止。`, false);
    }
  }

  function detail(id: string): EdictDetail {
    const edict = store.getEdict(id);
    return {
      edict,
      drafts: store.listDrafts(id),
      reviews: store.listReviews(id),
      tasks: store.listTasksOfEdict(id),
      transitions: store.listTransitions("edict", id),
    };
  }

  function actorAddr(a: FlowActor): Address {
    return a.post ? postAddress(a.post) : a.addr;
  }

  // ── 对外 ──
  const flow = {
    detail,
    stageBrief,
    openBlockingIssues,
    priorIssues,

    getEdictOrNull(id: string): EdictRow | undefined {
      return store.getEdictOrNull(id);
    },

    listEdicts(state: string | undefined, limit: number): EdictRow[] {
      return store.listEdicts(state, limit);
    },

    issueEdict(input: IssueEdictInput): EdictRow {
      const title = (input.title ?? "").trim();
      const intent = (input.intent ?? "").trim();
      if (!title) throw bad("颁旨须有标题（title）");
      if (!intent) throw bad("颁旨须写明旨意（intent）");
      return ctx.db.tx(() => {
        if (input.deliberation_id) store.getDeliberation(input.deliberation_id);
        const now = env.now();
        const id = newId("ed");
        const e: EdictRow = {
          id,
          title,
          intent,
          state: "issued",
          version: 1,
          deliberation_id: input.deliberation_id,
          skip_review: !!input.skip_review,
          draft_no: 0,
          reject_count: 0,
          remonstrated_draft_nos: [],
          budget_tokens: input.budget_tokens,
          deadline: input.deadline_minutes ? now + input.deadline_minutes * 60_000 : undefined,
          created_at: now,
          state_entered_at: now,
          root_span_id: edictSpanId(id),
        };
        store.createEdict(e, now);
        ctx.events.span({
          span_id: edictSpanId(id),
          trace_id: id,
          kind: "edict",
          name: title,
          actor: input.actor,
          status: "running",
          started_at: now,
          attrs: { edict_id: id, skip_review: e.skip_review, deliberation_id: e.deliberation_id },
        });
        if (input.deliberation_id) ctx.events.link(`sp_${input.deliberation_id}`, edictSpanId(id), "causes", id, "议事颁旨");
        env.emit("edict.issued", input.actor, `颁旨：${title}${e.skip_review ? "（墨敕）" : ""}`, { trace_id: id, span_id: edictSpanId(id), subject_type: "edict", subject_id: id });
        enterDrafting(e, input.actor, "颁旨，指派中书舍人起草");
        return store.updateEdict(e, now);
      });
    },

    submitDraft(id: string, input: DraftInput, actor: FlowActor): EdictDetail & { note: string } {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        checkVersion(input.expected_version, e.version, versionConflict);
        requireState(e, ["drafting"], "提交草稿");
        if (e.awaiting_countersign) throw invalidState(`第 ${e.draft_no} 稿正待中书侍郎复署，不能重复提交；请等待复署结果`);
        if (!isEmperorActor(actor) && actor.post !== e.drafter_post && !isDeptRole(actor.post, "zhongshu", ["head"])) {
          throw forbidden(`诏令 ${e.id} 的起草人是 ${e.drafter_post ?? "（未指派）"}，你（${actor.post}）不能提交草稿`);
        }
        const open = openBlockingIssues(e);
        if (open.length) {
          const answered = new Set(input.responses.filter((r) => r.response.trim()).map((r) => r.issue_id));
          const missing = open.filter((i) => !answered.has(i.id));
          if (missing.length) {
            throw bad(
              `本稿须逐条回应上次封驳的 blocking 问题，尚缺：${missing.map((i) => i.id).join(", ")}。请在 responses 中按 {issue_id, response} 补齐：\n${renderIssues(missing)}`,
            );
          }
        }
        const now = env.now();
        const no = e.draft_no + 1;
        const author = actor.post ?? "emperor";
        const isHead = isDeptRole(actor.post, "zhongshu", ["head"]);
        const draft: EdictDraft = {
          edict_id: id,
          no,
          title: input.title,
          objective: input.objective,
          constraints: input.constraints,
          acceptance: input.acceptance,
          deadline_text: input.deadline_text,
          budget_tokens: input.budget_tokens,
          suggested_depts: input.suggested_depts,
          text: input.text,
          responses: input.responses,
          author_post: author,
          countersigned_by: isHead ? actor.post : undefined,
          created_at: now,
        };
        store.createDraft(draft);
        e.draft_no = no;
        if (input.budget_tokens && !e.budget_tokens) e.budget_tokens = input.budget_tokens;
        ctx.events.span({
          span_id: `sp_${id}_d${no}`,
          trace_id: id,
          parent_span_id: edictSpanId(id),
          kind: "draft",
          name: `第 ${no} 稿`,
          actor: actorAddr(actor),
          status: "ok",
          started_at: e.state_entered_at,
          ended_at: now,
          attrs: { draft_no: no, responses: input.responses.length, by_span: actor.span },
        });
        env.emit("edict.draft", actorAddr(actor), `提交第 ${no} 稿：${clip(input.title, 80)}`, { trace_id: id, span_id: `sp_${id}_d${no}`, subject_type: "edict", subject_id: id });
        const head = countersigner();
        // 中书侍郎缺位时免复署，否则诏令将停在「待复署」无人可动
        const needCountersign = !!reg().dept("zhongshu")?.countersign && !isHead && !isEmperorActor(actor) && !!head;
        if (needCountersign) {
          e.awaiting_countersign = true;
          // 复署也带租约：到期看门狗检查复署人是否仍在任（缺位则免复署送门下）
          e.lease_until = now + SLA.lease * 1000;
          notifyEdict(head, e, `请复署诏令草稿：${e.title}（第 ${no} 稿）`, `${renderDraft(draft)}\n\n请确认草稿准确传达了陛下旨意：合格则 edict_countersign approve=true 送门下；不合格则 approve=false 并写明意见退回舍人重拟。`);
        } else {
          enterReviewing(e, actorAddr(actor), `第 ${no} 稿提交${!head && !isHead && !isEmperorActor(actor) ? "（中书侍郎缺位，免复署）" : ""}`);
        }
        store.updateEdict(e, now);
        return { ...detail(id), note: stageNote(e) };
      });
    },

    countersign(id: string, input: { approve: boolean; comment: string }, actor: FlowActor): EdictDetail & { note: string } {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        requireState(e, ["drafting"], "复署");
        if (!e.awaiting_countersign) throw invalidState(`诏令 ${e.id} 当前没有待复署的草稿（第 ${e.draft_no} 稿尚未提交或已复署）`);
        if (!isEmperorActor(actor) && !isDeptRole(actor.post, "zhongshu", ["head", "deputy"])) throw forbidden(`只有中书侍郎（中书省长官）可以复署，你是 ${actor.post}`);
        const now = env.now();
        const who = actorAddr(actor);
        const draft = store.getLatestDraftOrNull(id);
        e.awaiting_countersign = false;
        if (input.approve) {
          if (draft) {
            draft.countersigned_by = actor.post ?? "emperor";
            store.updateDraft(draft);
          }
          env.emit("edict.countersigned", who, `复署第 ${e.draft_no} 稿`, { trace_id: id, subject_type: "edict", subject_id: id });
          enterReviewing(e, who, `中书侍郎复署第 ${e.draft_no} 稿${input.comment ? "：" + clip(input.comment, 100) : ""}`);
        } else {
          if (!input.comment.trim()) throw bad("退回重拟时必须在 comment 中写明问题与修改意见");
          ctx.transition("edict", e.id, "drafting", "drafting", who, `中书侍郎退回第 ${e.draft_no} 稿：${clip(input.comment, 200)}`, e.id);
          e.lease_until = now + SLA.lease * 1000;
          notifyEdict(e.drafter_post, e, `草稿被侍郎退回：${e.title}`, `${draftingBrief(e, `中书侍郎退回第 ${e.draft_no} 稿：${input.comment}`)}`);
        }
        store.updateEdict(e, now);
        return { ...detail(id), note: stageNote(e) };
      });
    },

    review(id: string, input: ReviewInput, actor: FlowActor): EdictDetail & { note: string } {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        checkVersion(input.expected_version, e.version, versionConflict);
        requireState(e, ["reviewing"], "审核");
        if (!isEmperorActor(actor) && actor.post !== e.reviewer_post && !isDeptRole(actor.post, "menxia", ["head"])) {
          throw forbidden(`诏令 ${e.id} 的主审是 ${e.reviewer_post ?? "（未指派）"}，你（${actor.post}）不能审核`);
        }
        const blocking = input.issues.filter((i) => i.severity === "blocking");
        if (input.decision === "reject" && !blocking.length) throw bad("封驳（decision=reject）至少需要 1 条 severity=blocking 的问题，并写明 clause、reason、required_change");
        if (input.decision === "approve" && blocking.length) throw bad("准奏（decision=approve）时不得含 blocking 问题；若有 blocking 问题请 decision=reject，次要意见请标为 advisory");
        const prior = priorIssues(e);
        if (reviewsSinceBaseline(e).length > 0 && blocking.length) {
          const priorIds = prior.map((i) => i.id);
          const fresh = blocking.filter((b) => !priorIds.some((pid) => b.clause.includes(pid)));
          if (fresh.length) {
            throw bad(
              `第2次及以后审核不得新增 blocking 问题，只能核对前次问题是否改好：每条 blocking 的 clause 必须引用前次问题编号（可引用：${priorIds.join(", ") || "无"}）。新发现的问题请标为 advisory。违规条目：${fresh.map((f) => clip(f.clause, 60)).join("；")}`,
            );
          }
        }
        const now = env.now();
        const who = actorAddr(actor);
        const review: EdictReview = {
          id: newId("rv"),
          edict_id: id,
          draft_no: e.draft_no,
          reviewer_post: actor.post ?? "emperor",
          decision: input.decision,
          issues: input.issues.map((i) => ({ ...i, id: newId("iss") })),
          opinion: input.opinion,
          created_at: now,
        };
        store.createReview(review);
        ctx.events.span({
          span_id: `sp_${review.id}`,
          trace_id: id,
          parent_span_id: edictSpanId(id),
          kind: "review",
          name: `审核第 ${e.draft_no} 稿：${input.decision === "approve" ? "准" : "封驳"}`,
          actor: who,
          status: input.decision === "approve" ? "ok" : "rejected",
          started_at: e.state_entered_at,
          ended_at: now,
          attrs: { review_id: review.id, draft_no: e.draft_no, issues: review.issues.length, by_span: actor.span },
        });
        if (input.decision === "reject") {
          e.reject_count += 1;
          const issuesText = renderIssues(review.issues);
          if (e.reject_count > LIMITS.maxRejects) {
            setState(e, "escalated", who, `封驳第 ${e.reject_count} 次，超过上限 ${LIMITS.maxRejects}，奏请圣裁`);
            env.askEmperor(
              {
                kind: "action_required",
                category: "escalation",
                title: `封驳升级：${e.title}`,
                body: `诏令 ${e.id} 已被门下封驳 ${e.reject_count} 次（上限 ${LIMITS.maxRejects}），请陛下圣裁。\n\n最新草稿：\n${renderDraft(store.getLatestDraftOrNull(id))}\n\n本次封驳意见：${input.opinion}\n${issuesText}`,
                from: "system:workflow",
                related: { type: "edict", id },
                options: [
                  { id: "force_approve", label: "墨敕照准" },
                  { id: "withdraw", label: "撤回" },
                  { id: "revise", label: "朕意修改" },
                ],
                trace_id: id,
              },
              { type: "reject_overflow", edict_id: id },
            );
            notifyEdict(e.drafter_post, e, `诏令封驳超限，已奏请圣裁：${e.title}`, `诏令 ${e.id} 封驳超限，已交陛下圣裁，请等待。`, false);
          } else {
            enterDrafting(e, who, `门下封驳（第 ${e.reject_count} 次）：${clip(input.opinion, 200)}`, `门下封驳意见：${input.opinion}`);
          }
        } else if (env.finalSignRequired()) {
          setState(e, "awaiting_sign", who, "门下审核通过，待陛下覆奏画可");
          env.askEmperor(
            {
              kind: "action_required",
              category: "report",
              title: `覆奏画可：${e.title}`,
              body: `诏令 ${e.id} 已经门下审核通过，请陛下画可后交尚书省执行。\n\n${renderDraft(store.getLatestDraftOrNull(id))}\n\n门下意见：${input.opinion}`,
              from: "system:workflow",
              related: { type: "edict", id },
              options: [
                { id: "sign", label: "画可" },
                { id: "withdraw", label: "撤回" },
              ],
              trace_id: id,
            },
            { type: "final_sign", edict_id: id },
          );
        } else {
          enterApproved(e, who, `门下审核通过：${clip(input.opinion, 200)}`);
        }
        store.updateEdict(e, now);
        return { ...detail(id), note: stageNote(e) };
      });
    },

    remonstrate(id: string, input: { risk: string; alternative: string }, actor: FlowActor): EdictDetail {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        requireState(e, ["drafting", "reviewing"], "谏诤");
        if (!isEmperorActor(actor) && !env.hasRole(actor.post, "remonstrator")) throw forbidden(`只有谏官（右/左散骑常侍）可以谏诤，你是 ${actor.post}`);
        if (e.remonstrated_draft_nos.includes(e.draft_no)) {
          throw invalidState(`第 ${e.draft_no} 稿已经谏诤过一次（同一版只能谏一次），请等待新稿后再谏`);
        }
        const now = env.now();
        const who = actorAddr(actor);
        e.remonstrated_draft_nos.push(e.draft_no);
        e.resume_state = e.state;
        setState(e, "remonstrated", who, `谏诤（第 ${e.draft_no} 稿）：${clip(input.risk, 200)}`);
        ctx.events.span({
          span_id: newId("sp"),
          trace_id: id,
          parent_span_id: edictSpanId(id),
          kind: "remonstrance",
          name: `谏诤（第 ${e.draft_no} 稿）`,
          actor: who,
          status: "ok",
          started_at: now,
          ended_at: now,
          attrs: { risk: clip(input.risk, 300), by_span: actor.span },
        });
        env.askEmperor(
          {
            kind: "action_required",
            category: "remonstrance",
            title: `谏诤：${e.title}`,
            body: `${who} 就诏令 ${e.id}「${e.title}」进谏。\n\n风险：${input.risk}\n\n替代方案：${input.alternative}\n\n原旨意：${clip(e.intent, 1500)}`,
            from: who,
            related: { type: "edict", id },
            options: [
              { id: "insist", label: "坚持原旨" },
              { id: "revise", label: "采纳修改" },
              { id: "withdraw", label: "撤回" },
            ],
            trace_id: id,
          },
          { type: "remonstrance", edict_id: id },
        );
        store.updateEdict(e, now);
        return detail(id);
      });
    },

    dispatch(id: string, input: { tasks: DispatchTaskSpec[]; note?: string; expected_version?: number }, actor: FlowActor): EdictDetail & { note: string } {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        checkVersion(input.expected_version, e.version, versionConflict);
        requireState(e, ["approved", "executing"], "分派");
        if (!isEmperorActor(actor) && actor.post !== e.dispatcher_post && !isDeptRole(actor.post, "shangshu", ["dispatcher"])) {
          throw forbidden(`只有尚书省分派官（仆射/左右丞）可以分派诏令，你是 ${actor.post}`);
        }
        if (!input.tasks.length) throw bad("分派至少需要 1 个任务（tasks）");
        for (const [i, t] of input.tasks.entries()) {
          if (!reg().dept(t.dept)) throw bad(`tasks[${i}].dept=${t.dept} 不存在；可选：${reg().depts().map((d) => d.id).join(", ")}`);
        }
        const now = env.now();
        const who = actorAddr(actor);
        if (actor.post) e.dispatcher_post = actor.post;
        const spanId = newId("sp");
        ctx.events.span({
          span_id: spanId,
          trace_id: id,
          parent_span_id: edictSpanId(id),
          kind: "dispatch",
          name: `分派 ${input.tasks.length} 项任务`,
          actor: who,
          status: "ok",
          started_at: now,
          ended_at: now,
          attrs: { note: input.note, depts: input.tasks.map((t) => t.dept), by_span: actor.span },
        });
        const created = input.tasks.map((spec) => tasks.createDispatchedTask(id, spec, e.dispatcher_post ?? "shangshu.youpuye", spanId));
        e.awaiting_redispatch = undefined;
        const wasApproved = e.state === "approved";
        if (wasApproved) setState(e, "executing", who, `分派 ${created.length} 项任务：${created.map((t) => `${t.dept}`).join("、")}`);
        else ctx.transition("edict", id, "executing", "executing", who, `追加分派 ${created.length} 项任务`, id);
        env.emit("edict.dispatched", who, `分派 ${created.length} 项任务`, { trace_id: id, span_id: spanId, subject_type: "edict", subject_id: id, data: { task_ids: created.map((t) => t.id) } });
        store.updateEdict(e, now);
        const note = `已自动通知各承办人：${created.map((t) => `${t.dept}→${t.assignee_post ?? "待指派（看门狗将按部门路由指派）"}`).join("、")}，无需另行发信`;
        return { ...detail(id), note };
      });
    },

    report(id: string, input: { summary: string; failures?: string }, actor: FlowActor): EdictDetail {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        requireState(e, ["executing"], "复奏");
        if (!isEmperorActor(actor) && actor.post !== e.dispatcher_post && !isDeptRole(actor.post, "shangshu", ["dispatcher"])) {
          throw forbidden(`只有尚书省分派官可以复奏，你是 ${actor.post}`);
        }
        const roots = store.listRootTasksOfEdict(id);
        if (!roots.length) throw invalidState(`诏令 ${id} 尚未分派任何任务，不能复奏；请先 edict_dispatch`);
        const open = roots.filter((t) => !isTaskTerminal(t.state));
        if (open.length) {
          throw invalidState(`诏令 ${id} 尚有 ${open.length} 项任务未终结，不能复奏：${open.map((t) => `${t.id}「${clip(t.title, 30)}」(${t.dept}, ${t.state})`).join("；")}`);
        }
        const now = env.now();
        const who = actorAddr(actor);
        e.report = { summary: input.summary, failures: input.failures ?? "", by: actor.post ?? "emperor", at: now };
        e.awaiting_redispatch = undefined;
        setState(e, "reported", who, "复奏");
        ctx.events.span({
          span_id: newId("sp"),
          trace_id: id,
          parent_span_id: edictSpanId(id),
          kind: "report",
          name: "复奏",
          actor: who,
          status: "ok",
          started_at: now,
          ended_at: now,
          attrs: { by_span: actor.span },
        });
        const list = roots.map((t) => `- ${t.dept}「${t.title}」：${t.state}${t.result ? `（${clip(t.result, 200)}）` : ""}`).join("\n");
        env.askEmperor(
          {
            kind: "action_required",
            category: "report",
            title: `复奏待御览：${e.title}`,
            body: `尚书省复奏诏令 ${id}「${e.title}」。\n\n汇总：${input.summary}\n\n失败与遗留：${input.failures || "无"}\n\n任务：\n${list}`,
            from: who,
            related: { type: "edict", id },
            options: [
              { id: "accept", label: "御览准奏" },
              { id: "reopen", label: "发回重办" },
            ],
            trace_id: id,
          },
          { type: "report", edict_id: id },
        );
        store.updateEdict(e, now);
        return detail(id);
      });
    },

    clarify(id: string, question: string, actor: FlowActor): Notification {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        if (isEdictTerminal(e.state)) throw invalidState(`诏令 ${id} 已终结（${e.state}），无需请旨`);
        const who = actorAddr(actor);
        // 请旨属上奏，计入每人每小时上奏限额，防止反复请旨刷屏
        if (actor.post) ctx.notifications.checkPetitionRate(who);
        if (actor.post && actor.post === e.drafter_post && e.state === "drafting") {
          // 等陛下答复期间延长起草租约
          e.lease_until = env.now() + SLA.lease * 6 * 1000;
          store.updateEdict(e, env.now());
        }
        env.emit("edict.clarify", who, `请旨：${clip(question, 100)}`, { trace_id: id, subject_type: "edict", subject_id: id });
        return env.askEmperor({
          kind: "action_required",
          category: "clarification",
          title: `请旨：${e.title}`,
          body: `${who} 就诏令 ${id}「${e.title}」请陛下明示：\n\n${question}\n\n原旨意：${clip(e.intent, 1500)}`,
          from: who,
          related: { type: "edict", id },
          options: [{ id: "reply", label: "答复" }],
          trace_id: id,
        });
      });
    },

    proposeEdict(input: { title: string; intent: string; rationale: string; deliberation_id?: string }, actor: FlowActor): Notification {
      return ctx.db.tx(() => {
        if (input.deliberation_id) store.getDeliberation(input.deliberation_id);
        const who = actorAddr(actor);
        const traceId = input.deliberation_id ? store.getDeliberation(input.deliberation_id).trace_id : newId("tr");
        return env.askEmperor(
          {
            kind: "action_required",
            category: "edict_proposal",
            title: `拟旨：${input.title}`,
            body: `${who} 奏请颁旨。\n\n标题：${input.title}\n\n旨意：${input.intent}\n\n理由：${input.rationale}`,
            from: who,
            related: input.deliberation_id ? { type: "deliberation", id: input.deliberation_id } : undefined,
            options: [
              { id: "approve", label: "准奏颁旨" },
              { id: "reject", label: "不准" },
              { id: "revise", label: "发回再议" },
            ],
            trace_id: traceId,
          },
          { type: "proposal", title: input.title, intent: input.intent, deliberation_id: input.deliberation_id, by: who },
        );
      });
    },

    /** 皇帝动作（Web 按钮或待办批复） */
    applyAction(id: string, action: EdictAction, comment: string, actor: Address = "emperor", notificationId?: string): EdictDetail {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        const now = env.now();
        const note = comment.trim();
        switch (action) {
          case "withdraw":
            if (isEdictTerminal(e.state)) throw invalidState(`诏令 ${id} 已终结（${e.state}），无需撤回`);
            withdraw(e, actor, note || "陛下撤回");
            break;
          case "force_approve":
            requireState(e, ["drafting", "reviewing", "escalated", "remonstrated", "awaiting_sign"], "墨敕照准");
            if (e.state === "awaiting_sign") {
              enterApproved(e, actor, `陛下画可${note ? "：" + note : ""}`);
            } else {
              e.skip_review = true;
              enterApproved(e, actor, `墨敕照准，绕过门下${note ? "：" + note : ""}`);
              notifyYushitai(e, `墨敕留痕：${e.title}`, `陛下以墨敕照准诏令 ${e.id}「${e.title}」，绕过门下审核（原状态见流转记录）。请御史台留档备查。`);
              env.emit("edict.force_approved", actor, `墨敕照准：${e.title}`, { trace_id: id, subject_type: "edict", subject_id: id });
            }
            break;
          case "sign":
            requireState(e, ["awaiting_sign"], "画可");
            enterApproved(e, actor, `陛下画可${note ? "：" + note : ""}`);
            break;
          case "insist":
            requireState(e, ["remonstrated", "escalated"], "坚持原旨");
            if (e.state === "escalated") {
              e.skip_review = true;
              enterApproved(e, actor, `陛下坚持原旨，墨敕照准${note ? "：" + note : ""}`);
              notifyYushitai(e, `墨敕留痕：${e.title}`, `诏令 ${e.id} 封驳超限后陛下坚持原旨照准。`);
            } else if (e.resume_state === "reviewing") {
              enterReviewing(e, actor, `陛下坚持原旨${note ? "：" + note : ""}`);
            } else {
              enterDrafting(e, actor, `陛下坚持原旨${note ? "：" + note : ""}`, note ? `陛下坚持原旨：${note}` : "陛下坚持原旨，请继续办理");
            }
            e.resume_state = undefined;
            break;
          case "revise":
            requireState(e, ["remonstrated", "escalated", "awaiting_sign"], "修改旨意");
            if (!note) throw bad("修改旨意须在 comment 中写明朕意");
            e.intent = `${e.intent}\n【朕批】${note}`;
            if (e.state === "escalated") e.reject_count = 0;
            e.review_baseline = e.draft_no + 1;
            e.resume_state = undefined;
            enterDrafting(e, actor, `陛下修改旨意：${clip(note, 200)}`, `陛下朱批修改旨意：${note}`);
            break;
          case "accept_report":
            requireState(e, ["reported"], "御览准奏");
            setState(e, "completed", actor, `御览准奏${note ? "：" + note : ""}`);
            ctx.events.endSpan(edictSpanId(id), "ok", { completed_at: now });
            notifyEdict(e.dispatcher_post, e, `复奏已准：${e.title}`, `陛下已御览准奏诏令 ${id}，结案。${note ? "\n朱批：" + note : ""}`, false);
            break;
          case "reopen":
            requireState(e, ["reported"], "发回重办");
            setState(e, "executing", actor, `发回重办：${clip(note, 200)}`);
            e.awaiting_redispatch = true;
            notifyEdict(
              e.dispatcher_post,
              e,
              `复奏被发回重办：${e.title}`,
              `陛下将诏令 ${id} 的复奏发回重办。\n朱批：${note || "（无）"}\n请按旨追加分派任务（edict_dispatch）或督办后重新复奏（edict_report）。`,
            );
            break;
          case "retry":
            requireState(e, ["failed", "blocked_budget"], "重试");
            if (e.state === "blocked_budget" && e.resume_state && e.resume_state !== "drafting") {
              const target = e.resume_state;
              e.resume_state = undefined;
              setState(e, target, actor, `陛下下旨重试${note ? "：" + note : ""}`);
              e.lease_until = now + SLA.lease * 1000;
              const who = target === "reviewing" ? e.reviewer_post : target === "approved" || target === "executing" ? e.dispatcher_post : e.drafter_post;
              notifyEdict(who, e, `诏令恢复办理：${e.title}`, stageBrief(e));
            } else {
              e.resume_state = undefined;
              enterDrafting(e, actor, `陛下下旨重试${note ? "：" + note : ""}`, note || "陛下下旨重新办理");
            }
            break;
          default:
            throw bad(`未知诏令动作 ${JSON.stringify(action)}；可选：withdraw / force_approve / insist / revise / accept_report / retry`);
        }
        store.dismissPendingNotifications(id, EDICT_NOTICE_CATEGORIES, notificationId);
        store.updateEdict(e, now);
        return detail(id);
      });
    },

    /** 看门狗：阶段租约过期 → 同角色改派；busy 为正在处理该诏令的职位 */
    reassignStale(id: string, busy: Set<string>, actor: Address): boolean {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        const now = env.now();
        if (!e.lease_until || e.lease_until > now) return false;
        if (e.state === "drafting" && e.awaiting_countersign) {
          // 复署人缺位 → 免复署送门下；仍在任则只续租约（催办交给 SLA 逐级上报）
          if (countersigner()) {
            e.lease_until = now + SLA.lease * 1000;
            store.updateEdict(e, now);
            return false;
          }
          e.awaiting_countersign = false;
          enterReviewing(e, actor, `中书侍郎缺位，第 ${e.draft_no} 稿免复署送门下`);
          store.updateEdict(e, now);
          return true;
        }
        const spec =
          e.state === "drafting" && !e.awaiting_countersign
            ? ({ dept: "zhongshu", role: "drafter", field: "drafter_post" } as const)
            : e.state === "reviewing"
              ? ({ dept: "menxia", role: "reviewer", field: "reviewer_post" } as const)
              : e.state === "approved"
                ? ({ dept: "shangshu", role: "dispatcher", field: "dispatcher_post" } as const)
                : undefined;
        if (!spec) return false;
        const cur = e[spec.field];
        const next = cur && busy.has(cur) ? undefined : reg().pickPost(spec.dept, [spec.role], { exclude: cur ? [cur] : [] });
        if (!next) {
          e.lease_until = now + SLA.lease * 1000;
          store.updateEdict(e, now);
          return false;
        }
        e[spec.field] = next;
        e.lease_until = now + SLA.lease * 1000;
        ctx.transition("edict", id, e.state, e.state, actor, `租约过期，${cur ?? "无人"} → ${next} 改派`, id);
        env.emit("edict.reassigned", actor, `${spec.role} 改派：${cur ?? "无"} → ${next}`, { trace_id: id, subject_type: "edict", subject_id: id });
        notifyEdict(next, e, `改派诏令：${e.title}`, `原经办人 ${cur ?? "（无）"} 逾时未办，现改派给你。\n\n${stageBrief(e)}`);
        notifyEdict(cur, e, `诏令已改派：${e.title}`, `诏令 ${id} 因你逾时未办，已改派给 ${next}。`, false);
        store.updateEdict(e, now);
        return true;
      });
    },

    /** 看门狗：执行中诏令的分派人缺位（复奏无人可办）→ 改派尚书省其他分派官 */
    rehomeDispatcher(id: string, actor: Address): boolean {
      return ctx.db.tx(() => {
        const e = store.getEdict(id);
        if (e.state !== "executing") return false;
        const cur = e.dispatcher_post;
        if (cur && reg().officialOf(cur)?.status === "active") return false;
        const next = reg().pickPost("shangshu", ["dispatcher"], { exclude: cur ? [cur] : [] });
        if (!next) return false;
        e.dispatcher_post = next;
        ctx.transition("edict", id, e.state, e.state, actor, `分派人 ${cur ?? "无人"} 缺位，改由 ${next} 督办复奏`, id);
        env.emit("edict.reassigned", actor, `dispatcher 改派：${cur ?? "无"} → ${next}`, { trace_id: id, subject_type: "edict", subject_id: id });
        const roots = store.listRootTasksOfEdict(id);
        const open = roots.filter((t) => !isTaskTerminal(t.state)).length;
        notifyEdict(next, e, `改由你督办诏令：${e.title}`, `原分派人 ${cur ?? "（无）"} 缺位，诏令 ${id} 改由你督办。任务 ${roots.length - open}/${roots.length} 已终结${roots.length && !open ? "，请汇总后 edict_report 复奏" : "，请督办，全部终结后复奏"}。`);
        store.updateEdict(e, env.now());
        return true;
      });
    },

    /** 复奏逾 24 小时未御览 → 自动结案 */
    autoComplete(id: string, actor: Address): void {
      ctx.db.tx(() => {
        const e = store.getEdict(id);
        if (e.state !== "reported") return;
        setState(e, "completed", actor, "复奏逾 24 小时未御览，自动结案");
        ctx.events.endSpan(edictSpanId(id), "ok", { auto_completed: true });
        store.dismissPendingNotifications(id, ["report"]);
        store.updateEdict(e, env.now());
      });
    },
  };
  return flow;
}

export type EdictFlow = ReturnType<typeof createEdictFlow>;
