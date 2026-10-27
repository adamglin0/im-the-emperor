// B 组测试用的内存 HubCtx：真实 Db(":memory:") + schema，A 组服务以简单假实现代替。
import { fileURLToPath } from "node:url";
import {
  effectiveToolGroups,
  loadCourtConfig,
  loadModelsConfig,
  newId,
  toolsForGroups,
  type Address,
  type CourtEvent,
  type GatewayCompleteReq,
  type GatewayCompleteRes,
  type Message,
  type ModelEntry,
  type Notification,
  type NotificationCategory,
  type Official,
  type OfficialStatus,
  type PostDef,
  type SendMessageReq,
  type Span,
} from "@court/shared";
import { Db } from "../src/db.ts";
import { bad, type HubCtx } from "../src/ctx.ts";
import { createWorkflow, type Workflow } from "../src/services/workflow.ts";
import { createBriefing } from "../src/services/briefing.ts";
import { createExams, type Exams, type GatewayLike } from "../src/services/exams.ts";
import { createAudit, type Audit } from "../src/services/audit.ts";

const CONFIG_DIR = fileURLToPath(new URL("../../../config", import.meta.url));

export interface FakeCtx extends HubCtx {
  clock: { t: number };
  vacant: Set<string>;
  statusList: OfficialStatus[];
  wf: Workflow;
  ex: Exams;
  au: Audit;
  /** 某职位收到的消息（按时间） */
  inboxOf(post: string): Message[];
  /** 发给皇帝的消息 */
  emperorMail(): Message[];
  notificationsList(category?: NotificationCategory, status?: string): Notification[];
  advance(ms: number): void;
}

export function createFakeCtx(opts: { t?: number; gateway?: GatewayLike } = {}): FakeCtx {
  const db = new Db(":memory:");
  db.migrate();
  const court = loadCourtConfig(`${CONFIG_DIR}/court.yaml`);
  const modelsCfg = loadModelsConfig(`${CONFIG_DIR}/models.yaml`);
  const clock = { t: opts.t ?? 1_800_000_000_000 };
  const vacant = new Set<string>();
  const ctx = { db, court, modelsCfg, dataDir: "/tmp/none", gatewayUrl: "http://127.0.0.1:9", gatewayToken: "gw", controlToken: "ctl", clock, vacant, statusList: [] } as unknown as FakeCtx;
  ctx.now = () => clock.t;
  ctx.advance = (ms) => {
    clock.t += ms;
  };

  // ── 名册 ──
  const posts: PostDef[] = court.posts;
  const models = new Map<string, ModelEntry>();
  for (const m of modelsCfg.models) {
    const key = `${m.provider}/${m.model_id}`;
    models.set(key, { key, provider: m.provider, model_id: m.model_id, name: m.name ?? key, status: (m.status as ModelEntry["status"]) ?? "candidate", added_at: 0 });
  }
  const officialOf = (postId: string): Official | undefined => {
    const p = court.posts.find((x) => x.post_id === postId);
    if (!p || vacant.has(postId)) return undefined;
    return {
      official_id: `of_${postId}`,
      name: p.name,
      model: p.model ?? modelsCfg.default_model,
      thinking: "low",
      prompt_overrides: "",
      extra_tool_groups: [],
      disabled_tool_groups: [],
      status: "active",
      config_version: 1,
      created_at: 0,
    };
  };
  const pickPost = (dept: string, roles: string[], o?: { exclude?: string[] }) => {
    const ex = new Set(o?.exclude ?? []);
    for (const r of roles) {
      const c = posts.filter((p) => p.dept === dept && p.roles.includes(r) && !ex.has(p.post_id) && officialOf(p.post_id));
      if (!c.length) continue;
      let best = c[0];
      let load = ctx.workflow?.openTaskCount(best.post_id) ?? 0;
      for (const p of c.slice(1)) {
        const l = ctx.workflow?.openTaskCount(p.post_id) ?? 0;
        if (l < load) {
          best = p;
          load = l;
        }
      }
      return best.post_id;
    }
    return undefined;
  };
  ctx.registry = {
    snapshot: () => ({ version: 1, depts: court.depts, posts, officials: [], appointments: [], models: [...models.values()], court_preamble: "", halted: false }),
    version: () => 1,
    bump: () => {},
    dept: (id) => court.depts.find((d) => d.id === id),
    depts: () => court.depts,
    post: (id) => posts.find((p) => p.post_id === id),
    posts: (dept) => (dept ? posts.filter((p) => p.dept === dept) : posts),
    officialOf,
    official: () => undefined,
    postOf: () => undefined,
    saveOfficial: (o) => o,
    pickPost,
    routeDept(dept, key, o) {
      const d = court.depts.find((x) => x.id === dept);
      if (!d) return undefined;
      const svc = d.services.find((s) => s.name === key);
      const roles = d.routing[key] ?? svc?.route_roles ?? d.routing["*"] ?? ["head"];
      return pickPost(dept, roles, o) ?? pickPost(dept, d.routing["*"] ?? [], o) ?? pickPost(dept, ["head", "deputy"], o);
    },
    toolsOf: (id) => {
      const p = posts.find((x) => x.post_id === id);
      return new Set(p ? toolsForGroups(effectiveToolGroups(p)) : []);
    },
    hasTool: (id, tool) => ctx.registry.toolsOf(id).has(tool),
    deptToken: () => undefined,
    deptByToken: () => undefined,
    isHalted: () => false,
    setHalted: () => {},
    systemPrompt: () => "",
    model: (k) => models.get(k),
    models: () => [...models.values()],
    saveModel: (m) => void models.set(m.key, m),
  };

  // ── 事件 / span ──
  ctx.events = {
    emit(e) {
      const uid = e.uid ?? newId("ev");
      const r = db.run(
        "INSERT OR IGNORE INTO events (uid, ts, type, actor, dept, trace_id, span_id, subject_type, subject_id, summary, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        uid,
        e.ts ?? clock.t,
        e.type,
        e.actor,
        e.dept ?? null,
        e.trace_id ?? null,
        e.span_id ?? null,
        e.subject_type ?? null,
        e.subject_id ?? null,
        e.summary,
        e.data ? JSON.stringify(e.data) : null,
      );
      return { ...e, id: r.lastInsertRowid, uid, ts: e.ts ?? clock.t } as CourtEvent;
    },
    ingest: () => 0,
    publish: (e) => ({ ...e, id: -1, uid: newId("ev"), ts: clock.t }) as CourtEvent,
    span(s) {
      const id = s.span_id ?? newId("sp");
      const prev = db.getJson<Span>("SELECT data_json FROM spans WHERE span_id = ?", id);
      const merged = { ...(prev ?? {}), ...s, span_id: id, status: s.status ?? prev?.status ?? "running", started_at: s.started_at ?? prev?.started_at ?? clock.t } as Span;
      db.run(
        "INSERT INTO spans (span_id, trace_id, parent_span_id, kind, status, started_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(span_id) DO UPDATE SET status = excluded.status, parent_span_id = excluded.parent_span_id, data_json = excluded.data_json",
        id,
        merged.trace_id,
        merged.parent_span_id ?? null,
        merged.kind,
        merged.status,
        merged.started_at,
        JSON.stringify(merged),
      );
      return id;
    },
    endSpan(id, status, attrs) {
      const prev = db.getJson<Span>("SELECT data_json FROM spans WHERE span_id = ?", id);
      if (!prev) return;
      const next = { ...prev, status, ended_at: clock.t, attrs: { ...(prev.attrs ?? {}), ...(attrs ?? {}) } };
      db.run("UPDATE spans SET status = ?, data_json = ? WHERE span_id = ?", status, JSON.stringify(next), id);
    },
    link(a, b, kind, trace, label) {
      db.run("INSERT OR IGNORE INTO span_links (from_span, to_span, kind, label, trace_id) VALUES (?, ?, ?, ?, ?)", a, b, kind, label ?? null, trace);
    },
    subscribe: () => () => {},
  };

  ctx.transition = (type, id, from, to, actor, reason, traceId) => {
    db.run("INSERT INTO transitions (subject_type, subject_id, from_state, to_state, actor, reason, at) VALUES (?, ?, ?, ?, ?, ?, ?)", type, id, from, to, actor, reason, clock.t);
    ctx.events.emit({ type: `${type}.state`, actor, trace_id: traceId, subject_type: type, subject_id: id, summary: `${from}→${to}` });
  };
  ctx.statuses = () => ctx.statusList;
  ctx.idem = {
    wrap(key, fn) {
      if (!key) return fn();
      return db.tx(() => {
        const hit = db.get<{ result_json: string }>("SELECT result_json FROM idempotency WHERE key = ?", key);
        if (hit) return JSON.parse(hit.result_json);
        const r = fn();
        db.run("INSERT INTO idempotency (key, result_json, status, at) VALUES (?, ?, 200, ?)", key, JSON.stringify(r ?? null), clock.t);
        return r;
      });
    },
  };

  // ── 消息 ──
  const nextSeq = (post: string) => {
    db.run("INSERT OR IGNORE INTO inbox_cursors (post_id, next_seq, acked_seq) VALUES (?, 1, 0)", post);
    const s = db.get<{ next_seq: number }>("SELECT next_seq FROM inbox_cursors WHERE post_id = ?", post)!.next_seq;
    db.run("UPDATE inbox_cursors SET next_seq = next_seq + 1 WHERE post_id = ?", post);
    return s;
  };
  function send(req: SendMessageReq, opts: { wakes?: boolean } = {}) {
    let to = req.to;
    if (to.startsWith("dept:")) to = `post:${ctx.registry.routeDept(to.slice(5), req.kind)}`;
    if (to.startsWith("post:") && !posts.some((p) => `post:${p.post_id}` === to)) throw bad(`收件职位 ${to} 不存在`);
    const parent = req.reply_to ? db.getJson<Message>("SELECT data_json FROM messages WHERE id = ?", req.reply_to) : undefined;
    const m: Message = {
      id: newId("msg"),
      from: req.from,
      to,
      cc: [],
      kind: req.kind,
      subject: req.subject,
      body: req.body,
      requires_reply: !!req.requires_reply,
      reply_to: req.reply_to,
      thread_id: parent?.thread_id ?? req.thread_id ?? newId("th"),
      trace_id: req.trace_id ?? parent?.trace_id ?? newId("tr"),
      span_id: newId("sp"),
      priority: req.priority ?? "normal",
      hop_count: (parent?.hop_count ?? 0) + 1,
      meta: req.meta,
      created_at: clock.t,
    };
    db.run(
      "INSERT INTO messages (id, from_addr, to_addr, kind, subject, thread_id, trace_id, reply_to, requires_reply, priority, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      m.id,
      m.from,
      m.to,
      m.kind,
      m.subject,
      m.thread_id,
      m.trace_id,
      m.reply_to ?? null,
      m.requires_reply ? 1 : 0,
      m.priority,
      m.created_at,
      JSON.stringify(m),
    );
    const routed: string[] = [];
    if (to.startsWith("post:")) {
      const post = to.slice(5);
      db.run("INSERT INTO deliveries (post_id, seq, message_id, wakes, role, created_at) VALUES (?, ?, ?, ?, 'to', ?)", post, nextSeq(post), m.id, opts.wakes === false || m.kind === "fyi" ? 0 : 1, clock.t);
      routed.push(post);
    }
    return { message: m, routed_to: routed };
  }
  ctx.messages = {
    send: (req) => send(req),
    get: (id) => db.getJson<Message>("SELECT data_json FROM messages WHERE id = ?", id),
    inbox(post, after, limit) {
      const rows = db.all<{ seq: number; message_id: string; wakes: number; role: "to" | "cc"; created_at: number; data_json: string }>(
        "SELECT d.seq, d.message_id, d.wakes, d.role, d.created_at, m.data_json FROM deliveries d JOIN messages m ON m.id = d.message_id WHERE d.post_id = ? AND d.seq > ? ORDER BY d.seq LIMIT ?",
        post,
        after,
        limit,
      );
      return {
        items: rows.map((r) => ({ delivery: { post_id: post, seq: r.seq, message_id: r.message_id, wakes: !!r.wakes, role: r.role, created_at: r.created_at }, message: JSON.parse(r.data_json) })),
        latest_seq: ctx.messages.latestSeq(post),
      };
    },
    ack: () => {},
    ackedSeq: () => 0,
    latestSeq: (post) => (db.get<{ next_seq: number }>("SELECT next_seq FROM inbox_cursors WHERE post_id = ?", post)?.next_seq ?? 1) - 1,
    thread: () => [],
    notifyPost(post, kind, subject, body, o = {}) {
      return send({ from: o.from ?? "system:hub", to: `post:${post}`, kind, subject, body, trace_id: o.trace_id, meta: o.meta, priority: o.priority }, { wakes: o.wakes }).message;
    },
  };
  ctx.inboxOf = (post) => ctx.messages.inbox(post, 0, 1000).items.map((i) => i.message);
  ctx.emperorMail = () => db.allJson<Message>("SELECT data_json FROM messages WHERE to_addr = 'emperor' ORDER BY rowid");

  // ── 待办 ──
  const handlers = new Map<string, ((n: Notification, o: string, c: string) => void)[]>();
  const saveN = (n: Notification) =>
    db.run(
      "INSERT INTO notifications (id, status, kind, category, from_addr, dedupe_key, created_at, data_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET status = excluded.status, data_json = excluded.data_json",
      n.id,
      n.status,
      n.kind,
      n.category,
      n.from,
      n.dedupe_key ?? null,
      n.created_at,
      JSON.stringify(n),
    );
  const getN = (id: string) => db.getJson<Notification>("SELECT data_json FROM notifications WHERE id = ?", id);
  ctx.notifications = {
    create(input) {
      if (input.dedupe_key) {
        const dup = db.getJson<Notification>("SELECT data_json FROM notifications WHERE dedupe_key = ? AND status = 'pending'", input.dedupe_key);
        if (dup) return dup;
      }
      const n: Notification = { ...input, id: newId("nt"), status: input.status ?? "pending", options: input.options ?? [], created_at: clock.t } as Notification;
      saveN(n);
      return n;
    },
    get: getN,
    list: (status) => (status ? db.allJson<Notification>("SELECT data_json FROM notifications WHERE status = ? ORDER BY rowid", status) : db.allJson<Notification>("SELECT data_json FROM notifications ORDER BY rowid")),
    resolve(id, option, comment) {
      return db.tx(() => {
        const n = getN(id);
        if (!n) throw bad(`no notification ${id}`);
        if (n.status !== "pending") throw bad(`already ${n.status}`);
        if (n.options.length && !n.options.some((o) => o.id === option)) throw bad(`bad option ${option}`);
        const done: Notification = { ...n, status: "resolved", resolution: { option, comment, at: clock.t } };
        saveN(done);
        for (const h of handlers.get(n.category) ?? []) h(done, option, comment);
        if (n.from.startsWith("post:")) {
          ctx.messages.notifyPost(n.from.slice(5), "notification_reply", `陛下批复：${n.title}`, `批复：${option}`, { from: "emperor", trace_id: n.trace_id, meta: { notification_id: n.id, option, comment } });
        }
        return getN(id)!;
      });
    },
    onResolve(category, h) {
      const l = handlers.get(category) ?? [];
      l.push(h);
      handlers.set(category, l);
    },
    checkPetitionRate: () => {},
  };
  ctx.notificationsList = (category, status) =>
    ctx.notifications.list(status).filter((n) => !category || n.category === category);

  // ── 其他 A 组服务（流程用不到，给最小桩） ──
  ctx.approvals = { request: () => ({}) as never, onApprove: () => {} };
  ctx.ledger = { append: () => 0, check: () => ({ allowed: true }), usageToday: () => ({ tokens: 0, cost: 0 }) };
  ctx.assets = { put: () => ({}) as never, canRead: () => true, read: () => ({}) as never, list: () => [] };
  ctx.schedules = { create: () => ({}) as never, seedDefaults: () => {}, tick: () => [] };
  ctx.doorbell = { ring: () => {}, control: async () => {}, deptHealth: () => ({}), markSeen: () => {} };

  // ── B 组 ──
  ctx.wf = createWorkflow(ctx);
  ctx.workflow = ctx.wf;
  ctx.briefing = createBriefing(ctx);
  ctx.ex = createExams(ctx, { gateway: opts.gateway ?? { complete: async () => Promise.reject(new Error("no gateway")) } });
  ctx.exams = ctx.ex;
  ctx.au = createAudit(ctx);
  ctx.audit = ctx.au;
  return ctx;
}

/** 构造网关应答 */
export function gwText(text: string, extra: Partial<GatewayCompleteRes["message"]> = {}): GatewayCompleteRes {
  return {
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { total: 0.001 } },
      durationMs: 5,
      ...extra,
    },
  };
}
export function gwTool(name: string, args: Record<string, unknown>): GatewayCompleteRes {
  return gwText("", { content: [{ type: "toolCall", id: "c1", name, arguments: args }], stopReason: "toolUse" });
}
export type { GatewayCompleteReq, Address };
