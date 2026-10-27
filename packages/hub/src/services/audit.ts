// 御史台稽查：确定性规则巡检（产出 audit_findings 并唤醒巡察御史）、弹劾、监察奏报。
import { SLA, newId, parseAddress, type Address, type AuditFinding, type Impeachment, type Notification } from "@court/shared";
import { bad, forbidden, notFound, type AuditService, type HubCtx } from "../ctx.ts";
import { clip } from "./flow-util.ts";
import { createFlowEnv } from "./workflow-env.ts";
import { taskSlaSeconds } from "./workflow-tasks.ts";
import type { EdictRow, TaskRow } from "./workflow-store.ts";

const AUDITOR: Address = "system:audit";
const MIN = 60_000;
const HOUR = 3600_000;
const LOOP_WINDOW = 30 * MIN;
const LOOP_MIN_MESSAGES = 8;
const IDLE_MIN_TURNS = 10;
const TOOL_ERRORS_MIN = 5;
const BUDGET_BURN_RATIO = 0.2;
/** 结果短于此长度且无资产，视为「宣称完成无产物」 */
const MIN_RESULT_CHARS = 6;
const IDLE_TOOLS = new Set(["end_turn", "sleep", "wait_for"]);

/** 弹劾批复选项（注意：不用 "dismiss"，那是待办服务保留的「撤下」选项） */
const IMPEACH_OPTIONS = [
  { id: "reject", label: "驳回" },
  { id: "to_libu", label: "交吏部整改" },
  { id: "to_hubu", label: "交户部降黜" },
  { id: "to_xingbu", label: "交刑部复核" },
];
const IMPEACH_DEPT: Record<string, string> = { to_libu: "libu", to_hubu: "hubu", to_xingbu: "xingbu" };
const FINDING_STATUSES: AuditFinding["status"][] = ["open", "reviewed", "impeached", "dismissed"];

type NewFinding = Omit<AuditFinding, "id" | "status" | "created_at"> & { dedupe_key: string };

export function createAudit(ctx: HubCtx) {
  const env = createFlowEnv(ctx);
  const reg = () => ctx.registry;

  const getFindingOrNull = (id: string) => ctx.db.getJson<AuditFinding>("SELECT data_json FROM audit_findings WHERE id = ?", id);
  const getImpeachmentOrNull = (id: string) => ctx.db.getJson<Impeachment>("SELECT data_json FROM impeachments WHERE id = ?", id);

  function saveFinding(f: AuditFinding): void {
    ctx.db.run("UPDATE audit_findings SET status = ?, data_json = ? WHERE id = ?", f.status, JSON.stringify(f), f.id);
  }
  function saveImpeachment(i: Impeachment): void {
    ctx.db.run(
      "INSERT INTO impeachments (id, status, created_at, data_json) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json",
      i.id,
      i.status,
      i.created_at,
      JSON.stringify(i),
    );
  }

  /** 写入发现（dedupe_key 去重），返回新插入的那条 */
  function insertFinding(nf: NewFinding, now: number): AuditFinding | undefined {
    const { dedupe_key, ...rest } = nf;
    const f: AuditFinding = { id: newId("af"), status: "open", created_at: now, ...rest };
    const r = ctx.db.run(
      "INSERT OR IGNORE INTO audit_findings (id, rule, subject, status, dedupe_key, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      f.id,
      f.rule,
      f.subject,
      f.status,
      dedupe_key,
      now,
      JSON.stringify(f),
    );
    return r.changes ? f : undefined;
  }

  // ── 规则 ──
  function loopChat(now: number): NewFinding[] {
    const rows = ctx.db.all<{ from_addr: string; to_addr: string; thread_id: string; trace_id: string }>(
      "SELECT from_addr, to_addr, thread_id, trace_id FROM messages WHERE created_at >= ? AND from_addr LIKE 'post:%' AND to_addr LIKE 'post:%' LIMIT 20000",
      now - LOOP_WINDOW,
    );
    const groups = new Map<string, { pair: [string, string]; thread: string; trace: string; n: number }>();
    for (const r of rows) {
      const pair = [r.from_addr, r.to_addr].sort() as [string, string];
      const key = `${r.thread_id}|${pair.join("|")}`;
      const g = groups.get(key) ?? { pair, thread: r.thread_id, trace: r.trace_id, n: 0 };
      g.n++;
      groups.set(key, g);
    }
    const bucket = Math.floor(now / LOOP_WINDOW);
    return [...groups.values()]
      .filter((g) => g.n >= LOOP_MIN_MESSAGES)
      .map((g) => ({
        rule: "loop_chat",
        severity: "medium" as const,
        subject: g.pair[0],
        trace_id: g.trace,
        summary: `${g.pair[0]} 与 ${g.pair[1]} 在同一线程 30 分钟内往来 ${g.n} 封信，疑似循环对话`,
        evidence: { thread_id: g.thread, pair: g.pair, count: g.n },
        dedupe_key: `loop_chat:${g.thread}:${g.pair.join(",")}:${bucket}`,
      }));
  }

  function isIdleTurn(data: Record<string, unknown> | undefined): boolean {
    if (!data) return false;
    // 运行时 turn.end：tools 为本轮工具名数组（优先），tool_calls 为计数（含 end_turn 本身）
    const list = Array.isArray(data.tools) ? data.tools : Array.isArray(data.tool_calls) ? data.tool_calls : undefined;
    if (list) {
      const names = list.map((x) => (typeof x === "string" ? x : String((x as { name?: unknown })?.name ?? "")));
      return names.every((n) => IDLE_TOOLS.has(n));
    }
    return data.tool_calls === 0;
  }

  function eventsByActor(type: string, since: number): Map<string, { n: number; data: Record<string, unknown>[]; trace?: string }> {
    const rows = ctx.db.all<{ actor: string; trace_id: string | null; data_json: string | null }>(
      "SELECT actor, trace_id, data_json FROM events WHERE type = ? AND ts >= ? LIMIT 20000",
      type,
      since,
    );
    const m = new Map<string, { n: number; data: Record<string, unknown>[]; trace?: string }>();
    for (const r of rows) {
      const g = m.get(r.actor) ?? { n: 0, data: [], trace: r.trace_id ?? undefined };
      g.n++;
      if (r.data_json && g.data.length < 20) {
        try {
          g.data.push(JSON.parse(r.data_json));
        } catch {
          /* 忽略坏数据 */
        }
      }
      m.set(r.actor, g);
    }
    return m;
  }

  function idleSpin(now: number): NewFinding[] {
    const rows = ctx.db.all<{ actor: string; data_json: string | null }>("SELECT actor, data_json FROM events WHERE type = 'turn.end' AND ts >= ? LIMIT 20000", now - HOUR);
    const idle = new Map<string, number>();
    for (const r of rows) {
      let data: Record<string, unknown> | undefined;
      try {
        data = r.data_json ? JSON.parse(r.data_json) : undefined;
      } catch {
        data = undefined;
      }
      if (isIdleTurn(data)) idle.set(r.actor, (idle.get(r.actor) ?? 0) + 1);
    }
    const bucket = Math.floor(now / HOUR);
    return [...idle]
      .filter(([, n]) => n >= IDLE_MIN_TURNS)
      .map(([actor, n]) => ({
        rule: "idle_spin",
        severity: "low" as const,
        subject: actor,
        summary: `${actor} 一小时内 ${n} 轮空转（无实际工具调用，只有结束/睡眠）`,
        evidence: { idle_turns: n, window: "1h" },
        dedupe_key: `idle_spin:${actor}:${bucket}`,
      }));
  }

  function overdue(now: number): NewFinding[] {
    const out: NewFinding[] = [];
    for (const t of env.store.listOpenTasks() as TaskRow[]) {
      const sla = taskSlaSeconds(t.state);
      if (!sla) continue;
      if (now - t.state_entered_at <= sla * 2000) continue;
      const subject = t.state === "submitted" ? t.verifier_post : t.assignee_post;
      out.push({
        rule: "overdue",
        severity: "medium",
        subject: subject ? `post:${subject}` : `dept:${t.dept}`,
        trace_id: t.trace_id,
        summary: `任务 ${t.id}「${clip(t.title, 40)}」在 ${t.state} 状态停留 ${Math.round((now - t.state_entered_at) / MIN)} 分钟，超过 SLA 两倍`,
        evidence: { task_id: t.id, state: t.state, since: t.state_entered_at, sla_seconds: sla },
        dedupe_key: `overdue:task:${t.id}:${t.state}:${t.state_entered_at}`,
      });
    }
    for (const e of env.store.listEdictsInStates(["drafting", "reviewing", "approved", "executing"]) as EdictRow[]) {
      if (!e.sla_at) continue;
      const span = e.sla_at - e.state_entered_at;
      if (now <= e.state_entered_at + span * 2) continue;
      const owner = e.state === "drafting" ? e.drafter_post : e.state === "reviewing" ? e.reviewer_post : e.dispatcher_post;
      out.push({
        rule: "overdue",
        severity: "high",
        subject: owner ? `post:${owner}` : "court",
        trace_id: e.id,
        summary: `诏令 ${e.id}「${clip(e.title, 40)}」在 ${e.state} 阶段停留 ${Math.round((now - e.state_entered_at) / MIN)} 分钟，超过时限两倍`,
        evidence: { edict_id: e.id, state: e.state, since: e.state_entered_at, sla_at: e.sla_at },
        dedupe_key: `overdue:edict:${e.id}:${e.state}:${e.state_entered_at}`,
      });
    }
    return out;
  }

  function perActorRule(now: number, type: string, rule: string, min: number, severity: AuditFinding["severity"], describe: (actor: string, n: number) => string): NewFinding[] {
    const bucket = Math.floor(now / HOUR);
    return [...eventsByActor(type, now - HOUR)]
      .filter(([, g]) => g.n >= min)
      .map(([actor, g]) => ({
        rule,
        severity,
        subject: actor,
        trace_id: g.trace,
        summary: describe(actor, g.n),
        evidence: { count: g.n, samples: g.data.slice(0, 5) },
        dedupe_key: `${rule}:${actor}:${bucket}`,
      }));
  }

  function claimedNoOutput(now: number): NewFinding[] {
    const rows = ctx.db.allJson<TaskRow>("SELECT data_json FROM tasks WHERE state IN ('submitted','done') AND updated_at >= ? LIMIT 2000", now - HOUR);
    return rows
      .filter((t) => (t.result ?? "").trim().length < MIN_RESULT_CHARS && !(t.result_assets ?? []).length)
      .map((t) => ({
        rule: "claimed_no_output",
        severity: "medium" as const,
        subject: t.assignee_post ? `post:${t.assignee_post}` : `dept:${t.dept}`,
        trace_id: t.trace_id,
        summary: `任务 ${t.id}「${clip(t.title, 40)}」已${t.state === "done" ? "办结" : "提交"}，但结果为空（「${clip(t.result ?? "", 20)}」）且无产物资产`,
        evidence: { task_id: t.id, state: t.state, result: t.result ?? "" },
        dedupe_key: `claimed_no_output:${t.id}`,
      }));
  }

  function budgetBurn(now: number): NewFinding[] {
    const rows = ctx.db.all<{ post_id: string; n: number }>("SELECT post_id, SUM(total_tokens) AS n FROM ledger WHERE ts >= ? GROUP BY post_id", now - HOUR);
    const bucket = Math.floor(now / HOUR);
    const out: NewFinding[] = [];
    for (const r of rows) {
      const b = ctx.db.getJson<{ daily_tokens?: number | null }>("SELECT data_json FROM budgets WHERE scope = ?", `post:${r.post_id}`);
      if (!b?.daily_tokens || r.n <= b.daily_tokens * BUDGET_BURN_RATIO) continue;
      out.push({
        rule: "budget_burn",
        severity: "high",
        subject: `post:${r.post_id}`,
        summary: `${r.post_id} 最近一小时消耗 ${r.n} tokens，超过其日额 ${b.daily_tokens} 的 ${BUDGET_BURN_RATIO * 100}%`,
        evidence: { tokens_last_hour: r.n, daily_tokens: b.daily_tokens },
        dedupe_key: `budget_burn:${r.post_id}:${bucket}`,
      });
    }
    return out;
  }

  /** 发现的接收人：巡察御史（role patrol），否则按御史台 audit 路由 */
  function patrolPost(): string | undefined {
    return reg().pickPost("yushitai", ["patrol"]) ?? reg().routeDept("yushitai", "audit");
  }

  function reconcileImpeachment(i: Impeachment): Impeachment {
    if (i.status !== "pending" || !i.notification_id) return i;
    const n = ctx.notifications.get(i.notification_id);
    if (n?.status === "dismissed") {
      i.status = "dismissed";
      saveImpeachment(i);
    }
    return i;
  }

  function resolveImpeachment(n: Notification, option: string, comment: string): void {
    const id = n.related?.id;
    if (!id) return;
    ctx.db.tx(() => {
      const i = getImpeachmentOrNull(id);
      if (!i || i.status !== "pending") return;
      const dept = IMPEACH_DEPT[option];
      i.status = option === "reject" ? "dismissed" : (option as Impeachment["status"]);
      saveImpeachment(i);
      const target = i.target.startsWith("post:") ? i.target.slice(5) : undefined;
      if (dept) {
        const handler = reg().routeDept(dept, "impeachment");
        const label = IMPEACH_OPTIONS.find((o) => o.id === option)?.label ?? option;
        env.notify(
          handler,
          "audit",
          `陛下交办弹劾案：${i.target}`,
          `陛下批复弹劾案 ${i.id}：${label}。\n被弹劾：${i.target}\n弹劾人：${i.by}\n罪状：${i.charges}\n证据：${clip(i.evidence, 3000)}${comment ? `\n朱批：${comment}` : ""}\n请依职权处置并奏报结果。`,
          { meta: { impeachment_id: i.id }, priority: "high" },
        );
      }
      env.notify(
        target,
        "fyi",
        `弹劾案处置结果：${i.id}`,
        `御史台对你的弹劾（${clip(i.charges, 200)}）已由陛下批复：${option === "reject" ? "驳回" : "交" + (dept ?? "") + "处置"}。${comment ? "\n朱批：" + comment : ""}`,
        { wakes: false, meta: { impeachment_id: i.id } },
      );
      ctx.events.emit({ type: "audit.impeachment_resolved", actor: "emperor", subject_type: "impeachment", subject_id: i.id, summary: `弹劾 ${i.target}：${option}` });
    });
  }
  env.onResolve("impeachment", resolveImpeachment);

  const self = {
    runRules(now: number): AuditFinding[] {
      const candidates: NewFinding[] = [];
      const safe = (fn: () => NewFinding[]) => {
        try {
          candidates.push(...fn());
        } catch (e) {
          ctx.events.emit({ type: "audit.error", actor: AUDITOR, summary: `稽查规则出错：${clip((e as Error).message ?? String(e), 300)}` });
        }
      };
      safe(() => loopChat(now));
      safe(() => idleSpin(now));
      safe(() => overdue(now));
      safe(() => perActorRule(now, "tool.error", "tool_errors", TOOL_ERRORS_MIN, "medium", (a, n) => `${a} 一小时内工具报错 ${n} 次`));
      safe(() => claimedNoOutput(now));
      safe(() => perActorRule(now, "acl.denied", "privilege_attempt", 1, "medium", (a, n) => `${a} 一小时内越权尝试 ${n} 次`));
      safe(() => budgetBurn(now));
      safe(() => perActorRule(now, "tool.injection_suspect", "injection_suspect", 1, "high", (a, n) => `${a} 一小时内出现 ${n} 次疑似提示注入`));
      return ctx.db.tx(() => {
        const fresh = candidates.map((c) => insertFinding(c, now)).filter((f): f is AuditFinding => !!f);
        if (!fresh.length) return fresh;
        for (const f of fresh) {
          ctx.events.emit({ type: "audit.finding", actor: AUDITOR, trace_id: f.trace_id, subject_type: "audit_finding", subject_id: f.id, summary: `[${f.rule}] ${clip(f.summary, 200)}`, data: { severity: f.severity, subject: f.subject } });
        }
        const post = patrolPost();
        env.notify(
          post,
          "audit",
          `稽查规则新发现 ${fresh.length} 条`,
          `稽查规则巡检新发现 ${fresh.length} 条，请复核（audit_findings），属实可弹劾（impeach），不实则驳回（audit_update_finding status=dismissed）：\n` +
            fresh.map((f) => `- ${f.id} [${f.severity}] ${f.rule} ${f.subject}：${clip(f.summary, 200)}`).join("\n"),
          { from: AUDITOR, meta: { finding_ids: fresh.map((f) => f.id) } },
        );
        return fresh;
      });
    },

    listFindings(q: { status?: string; subject?: string; limit?: number }): AuditFinding[] {
      const where: string[] = [];
      const params: (string | number)[] = [];
      if (q.status) {
        where.push("status = ?");
        params.push(q.status);
      }
      if (q.subject) {
        where.push("subject = ?");
        params.push(q.subject);
      }
      const limit = Math.min(Math.max(1, Number(q.limit) || 100), 500);
      return ctx.db.allJson<AuditFinding>(`SELECT data_json FROM audit_findings ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at DESC LIMIT ?`, ...params, limit);
    },

    updateFinding(id: string, actor: Address, status: AuditFinding["status"], note?: string): AuditFinding {
      if (!FINDING_STATUSES.includes(status)) throw bad(`status 无效：${status}；可选：${FINDING_STATUSES.join(" / ")}`);
      return ctx.db.tx(() => {
        const f = getFindingOrNull(id);
        if (!f) throw notFound(`稽查发现 ${id}`);
        f.status = status;
        if (note?.trim()) {
          const notes = Array.isArray(f.evidence.review_notes) ? (f.evidence.review_notes as unknown[]) : [];
          f.evidence = { ...f.evidence, review_notes: [...notes, { by: actor, note: note.trim(), at: ctx.now() }] };
        }
        saveFinding(f);
        ctx.events.emit({ type: "audit.finding_updated", actor, subject_type: "audit_finding", subject_id: id, summary: `稽查发现 ${id} → ${status}` });
        return f;
      });
    },

    impeach(input: { post: string; target: Address; charges: string; evidence: string; finding_ids: string[] }): Impeachment {
      let addr: ReturnType<typeof parseAddress>;
      try {
        addr = parseAddress(input.target);
      } catch {
        throw bad(`target 地址非法：${input.target}；应为 post:<职位id>`);
      }
      if (addr.type !== "post" && addr.type !== "dept") throw bad("只能弹劾官员（post:<职位id>）或部门（dept:<部门id>）");
      if (addr.type === "post" && !reg().post(addr.id)) throw bad(`职位 ${addr.id} 不存在`);
      if (addr.type === "dept" && !reg().dept(addr.id)) throw bad(`部门 ${addr.id} 不存在`);
      if (addr.type === "post" && addr.id === input.post) throw forbidden("不能弹劾自己");
      return ctx.db.tx(() => {
        for (const fid of input.finding_ids) if (!getFindingOrNull(fid)) throw bad(`稽查发现 ${fid} 不存在，请用 audit_findings 核对编号`);
        const now = ctx.now();
        const by: Address = input.post === "emperor" ? "emperor" : `post:${input.post}`;
        const i: Impeachment = {
          id: newId("im"),
          by,
          target: input.target,
          charges: input.charges,
          evidence: input.evidence,
          finding_ids: input.finding_ids,
          status: "pending",
          notification_id: "",
          created_at: now,
        };
        const n = ctx.notifications.create({
          kind: "action_required",
          category: "impeachment",
          title: `弹劾：${input.target}`,
          body: `${by} 弹劾 ${input.target}。\n\n罪状：${input.charges}\n\n证据：${clip(input.evidence, 4000)}${input.finding_ids.length ? `\n\n关联稽查发现：${input.finding_ids.join(", ")}` : ""}`,
          from: by,
          related: { type: "impeachment", id: i.id },
          options: IMPEACH_OPTIONS,
        });
        i.notification_id = n.id;
        saveImpeachment(i);
        for (const fid of input.finding_ids) {
          const f = getFindingOrNull(fid)!;
          f.status = "impeached";
          saveFinding(f);
        }
        ctx.events.emit({ type: "audit.impeach", actor: by, subject_type: "impeachment", subject_id: i.id, summary: `弹劾 ${input.target}：${clip(input.charges, 120)}` });
        return i;
      });
    },

    report(input: { post: string; title: string; body: string }): Notification {
      const from: Address = input.post === "emperor" ? "emperor" : `post:${input.post}`;
      return ctx.notifications.create({ kind: "fyi", category: "audit_report", title: input.title, body: input.body, from, options: [] });
    },

    listImpeachments(): Impeachment[] {
      return ctx.db.tx(() => ctx.db.allJson<Impeachment>("SELECT data_json FROM impeachments ORDER BY created_at DESC LIMIT 500").map(reconcileImpeachment));
    },

    getImpeachmentOrNull,
  };
  return self satisfies AuditService;
}

export type Audit = ReturnType<typeof createAudit>;

export function auditOf(ctx: HubCtx): Audit {
  return ctx.audit as Audit;
}

