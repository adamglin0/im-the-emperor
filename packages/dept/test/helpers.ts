// 测试辅助：进程内假 hub（hono，经 fetchImpl 调用，不开端口）、脚本化 StreamFn、最小工具集。
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { AgentTool, StreamFn } from "@earendil-works/pi-agent-core";
import { Type, createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  newId,
  type Briefing,
  type DeptDef,
  type EventIn,
  type InboxItem,
  type Message,
  type Official,
  type PendingItem,
  type PostDef,
  type Registry,
  type SendMessageReq,
} from "@court/shared";
import type { ToolContext } from "../src/tool-context.ts";
import { DeptRuntime } from "../src/runtime.ts";
import type { Limits } from "../src/official.ts";

export const DEPT = "menxia";
export const POST = "menxia.jishizhong_a";
export const OFFICIAL_ID = "of_test1";

export function tmpDataDir(): string {
  return mkdtempSync(join(tmpdir(), "court-dept-"));
}

export function makePost(over: Partial<PostDef> = {}): PostDef {
  return {
    post_id: POST,
    dept: DEPT,
    title: "给事中",
    rank: "正五品上",
    duties: "审核诏令",
    tool_groups: ["common", "review"],
    roles: ["reviewer"],
    activity: "always",
    interruptible_by: ["emperor", "edict", "urgent"],
    default_wait_seconds: 3600,
    approval_sensitive: true,
    ...over,
  };
}

export function makeOfficial(over: Partial<Official> = {}): Official {
  return {
    official_id: OFFICIAL_ID,
    name: "魏玄成",
    model: "opencode-go/deepseek-v4.1-flash",
    thinking: "low",
    prompt_overrides: "",
    extra_tool_groups: [],
    disabled_tool_groups: [],
    status: "active",
    config_version: 1,
    created_at: 0,
    ...over,
  };
}

const DEPT_DEF: DeptDef = { id: DEPT, name: "门下省", brief: "审议封驳", duties: "审核", host: "dept-menxia", port: 8080, routing: { "*": ["reviewer"] }, services: [] };

export interface AckRecord {
  post: string;
  seq: number;
  sessionHadDoneTurn: boolean;
}

/** 假 hub：只实现 dept runtime 用到的接口 */
export class FakeHub {
  registry: Registry;
  inboxes = new Map<string, InboxItem[]>();
  acked = new Map<string, number>();
  pending = new Map<string, PendingItem[]>();
  events: EventIn[] = [];
  sent: { req: SendMessageReq; headers: Record<string, string> }[] = [];
  acks: AckRecord[] = [];
  budgetAllowed = false;
  systemPrompt = "你是门下省给事中，掌封驳。";
  completeCalls: unknown[] = [];
  heartbeats = 0;
  /** 心跳里上报过的「职位:状态」序列 */
  heartbeatStates: string[] = [];
  /** >0 时简报接口返回 503 并减一（模拟 hub 抖动） */
  briefingFailures = 0;
  app = new Hono();
  dataDir: string;

  constructor(dataDir: string, post: PostDef = makePost(), official: Official = makeOfficial()) {
    this.dataDir = dataDir;
    this.registry = {
      version: 1,
      depts: [DEPT_DEF, { ...DEPT_DEF, id: "zhongshu", name: "中书省", host: "dept-zhongshu" }],
      posts: [post, makePost({ post_id: "zhongshu.sheren_a", dept: "zhongshu", title: "中书舍人" })],
      officials: [official],
      appointments: [{ post_id: post.post_id, official_id: official.official_id, since: 0 }],
      models: [],
      court_preamble: "",
      halted: false,
    };
    const a = this.app;
    a.get("/api/registry", (c) => c.json(this.registry));
    a.post("/api/heartbeat", async (c) => {
      this.heartbeats++;
      const body = (await c.req.json().catch(() => ({}))) as { statuses?: { post_id: string; state: string }[] };
      for (const s of body.statuses ?? []) this.heartbeatStates.push(`${s.post_id}:${s.state}`);
      return c.json({ ok: true, halted: this.registry.halted, registry_version: this.registry.version });
    });
    a.get("/api/inbox/:post/cursor", (c) => {
      const p = c.req.param("post");
      const items = this.inboxes.get(p) ?? [];
      return c.json({ acked_seq: this.acked.get(p) ?? 0, latest_seq: items.length ? items[items.length - 1].delivery.seq : 0 });
    });
    a.get("/api/inbox/:post", (c) => {
      const p = c.req.param("post");
      const after = Number(c.req.query("after") ?? 0);
      const limit = Number(c.req.query("limit") ?? 100);
      const all = this.inboxes.get(p) ?? [];
      return c.json({ items: all.filter((i) => i.delivery.seq > after).slice(0, limit), latest_seq: this.latestSeq(p) });
    });
    a.post("/api/inbox/:post/ack", async (c) => {
      const p = c.req.param("post");
      const { seq } = await c.req.json();
      this.acks.push({ post: p, seq, sessionHadDoneTurn: this.sessionHasDoneTurn() });
      this.acked.set(p, Math.max(this.acked.get(p) ?? 0, seq));
      return c.json({ ok: true });
    });
    a.get("/api/briefing/:post", (c) => {
      if (this.briefingFailures > 0) {
        this.briefingFailures--;
        return c.json({ error: "皇城繁忙", code: "unavailable" }, 503);
      }
      const p = c.req.param("post");
      const after = Number(c.req.query("after") ?? 0);
      const msgs = (this.inboxes.get(p) ?? []).filter((i) => i.delivery.seq > after && i.delivery.wakes);
      const items: PendingItem[] = [
        ...msgs.map((i) => ({
          type: "message" as const,
          message_id: i.message.id,
          from: i.message.from,
          kind: i.message.kind,
          subject: i.message.subject,
          requires_reply: i.message.requires_reply,
          trace_id: i.message.trace_id,
        })),
        ...(this.pending.get(p) ?? []),
      ];
      const b: Briefing = { post_id: p, generated_at: Date.now(), wake_reason: c.req.query("wake_reason") ?? "", items, more: 0, latest_seq: this.latestSeq(p) };
      return c.json(b);
    });
    a.get("/api/config/:post", (c) => {
      const p = c.req.param("post");
      const post = this.registry.posts.find((x) => x.post_id === p)!;
      const appt = this.registry.appointments.find((x) => x.post_id === p)!;
      const official = this.registry.officials.find((o) => o.official_id === appt.official_id)!;
      return c.json({ official, post, effective_tool_groups: post.tool_groups, system_prompt: this.systemPrompt });
    });
    a.post("/api/messages", async (c) => {
      const req = (await c.req.json()) as SendMessageReq;
      this.sent.push({ req, headers: { authorization: c.req.header("authorization") ?? "", "x-acting-post": c.req.header("x-acting-post") ?? "" } });
      const to = req.to.startsWith("post:") ? req.to.slice(5) : req.to;
      const m = this.addMessage(to, { from: req.from, subject: req.subject, body: req.body, kind: req.kind });
      return c.json({ message: m.message, routed_to: [to] });
    });
    a.post("/api/events", async (c) => {
      const { events } = await c.req.json();
      this.events.push(...events);
      return c.json({ ok: true, inserted: events.length });
    });
    a.post("/api/budget/check", (c) => c.json({ allowed: this.budgetAllowed }));
    a.post("/api/complete", async (c) => {
      this.completeCalls.push(await c.req.json());
      return c.json({
        message: {
          role: "assistant",
          content: [{ type: "text", text: "【摘要】早先审过诏令 ed_1。" }],
          stopReason: "stop",
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
        },
      });
    });
  }

  private sessionHasDoneTurn(): boolean {
    const f = join(this.dataDir, "officials", OFFICIAL_ID, "session.jsonl");
    if (!existsSync(f)) return false;
    return readFileSync(f, "utf8").split("\n").filter(Boolean).some((l) => {
      const r = JSON.parse(l);
      return r.type === "turn" && r.status === "done";
    });
  }

  latestSeq(post: string): number {
    const items = this.inboxes.get(post) ?? [];
    return items.length ? items[items.length - 1].delivery.seq : 0;
  }

  addMessage(post: string, m: Partial<Message> & { from: string }, wakes = true): InboxItem {
    const items = this.inboxes.get(post) ?? [];
    const seq = items.length ? items[items.length - 1].delivery.seq + 1 : 1;
    const message: Message = {
      id: newId("msg"),
      to: `post:${post}`,
      cc: [],
      kind: "chat",
      subject: "来信",
      body: "正文",
      requires_reply: false,
      thread_id: newId("th"),
      trace_id: newId("tr"),
      span_id: newId("sp"),
      priority: "normal",
      hop_count: 0,
      created_at: Date.now(),
      ...m,
    };
    const item: InboxItem = { delivery: { post_id: post, seq, message_id: message.id, wakes, role: "to", created_at: Date.now() }, message };
    items.push(item);
    this.inboxes.set(post, items);
    return item;
  }

  fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(url);
    // 只接管 hub/gateway 假地址
    if (u.hostname !== "hub" && u.hostname !== "gateway") return fetch(input, init);
    return this.app.fetch(new Request(url, init as RequestInit));
  };
}

// ───────────────────────── 脚本化模型 ─────────────────────────

export type Responder = (ctx: TranscriptContext) => AssistantMessage;

export interface ScriptedModel {
  streamFn: StreamFn;
  calls: { ctx: TranscriptContext; options: Record<string, unknown> | undefined }[];
  push(...r: (Responder | AssistantMessage)[]): void;
}

export function scriptedModel(): ScriptedModel {
  const queue: Responder[] = [];
  const calls: ScriptedModel["calls"] = [];
  const streamFn: StreamFn = (_model, ctx, options) => {
    calls.push({ ctx, options: options as Record<string, unknown> | undefined });
    const r = queue.shift();
    const msg = r ? r(ctx) : fauxAssistantMessage([fauxToolCall("end_turn", { note: "无剧本，结束" })], { stopReason: "toolUse" });
    const s = createAssistantMessageEventStream();
    queueMicrotask(() => {
      s.push({ type: "start", partial: msg });
      if (msg.stopReason === "error" || msg.stopReason === "aborted") s.push({ type: "error", reason: msg.stopReason, error: msg });
      else s.push({ type: "done", reason: msg.stopReason as "stop", message: msg });
      s.end();
    });
    return s;
  };
  return {
    streamFn,
    calls,
    push: (...rs) => {
      for (const r of rs) queue.push(typeof r === "function" ? r : () => r);
    },
  };
}

export const toolCallMsg = (name: string, args: Record<string, unknown>, id?: string) =>
  fauxAssistantMessage([fauxToolCall(name, args, id ? { id } : {})], { stopReason: "toolUse" });

export const errorMsg = (errorMessage: string) => fauxAssistantMessage("", { stopReason: "error", errorMessage });

export const abortedMsg = () => fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request aborted by user" });

export function lastUserText(ctx: TranscriptContext): string {
  for (let i = ctx.messages.length - 1; i >= 0; i--) {
    const m = ctx.messages[i];
    if (m.role === "user") return typeof m.content === "string" ? m.content : m.content.map((b) => (b.type === "text" ? b.text : "")).join("");
  }
  return "";
}

// ───────────────────────── 最小工具集 ─────────────────────────

export function testTools(ctx: ToolContext): AgentTool<any>[] {
  const ok = (text: string, terminate = false) => ({ content: [{ type: "text" as const, text }], details: {}, terminate });
  return [
    {
      name: "end_turn",
      label: "结束本轮",
      description: "结束本轮",
      parameters: Type.Object({ note: Type.String() }),
      execute: async (_id, p: { note: string }) => {
        ctx.endTurn(p.note);
        return ok("本轮结束", true);
      },
    },
    {
      name: "sleep",
      label: "睡眠",
      description: "睡眠",
      parameters: Type.Object({ seconds: Type.Number(), reason: Type.String() }),
      execute: async (_id, p: { seconds: number; reason: string }) => {
        ctx.sleep(p.seconds, p.reason);
        return ok("已睡", true);
      },
    },
    {
      name: "wait_for",
      label: "等待",
      description: "等待",
      parameters: Type.Object({ from: Type.Optional(Type.Array(Type.String())), timeout_seconds: Type.Number() }),
      execute: async (_id, p: { from?: string[]; timeout_seconds: number }) => {
        ctx.waitFor({ from: p.from }, p.timeout_seconds);
        return ok("等待中", true);
      },
    },
    {
      name: "send_message",
      label: "发信",
      description: "发信",
      parameters: Type.Object({ to: Type.String(), body: Type.String() }),
      execute: async (id, p: { to: string; body: string }) => {
        const res = await ctx.deliver({ from: `post:${ctx.post.post_id}`, to: p.to, kind: "chat", subject: "信", body: p.body, idem_key: ctx.idemKey(id) });
        ctx.log("message_out", { to: p.to, message_id: res.message.id });
        return ok(`已发 ${res.message.id}`);
      },
    },
    {
      name: "slow",
      label: "慢工具",
      description: "等待若干毫秒",
      parameters: Type.Object({ ms: Type.Number() }),
      execute: async (_id, p: { ms: number }) => {
        await new Promise((r) => setTimeout(r, p.ms));
        return ok("慢工具完成");
      },
    },
    {
      name: "compact_memory",
      label: "自我整理",
      description: "自我整理",
      parameters: Type.Object({ summary: Type.String() }),
      execute: async (_id, p: { summary: string }) => {
        ctx.requestCompaction(p.summary);
        return ok("将于本轮后整理");
      },
    },
  ];
}

export const FAST_LIMITS: Partial<Limits> = {
  wakeDebounceMs: 5,
  minTurnGapMs: 0,
  heartbeatMs: 50,
  inboxPollMs: 600_000,
};

export function makeRuntime(hub: FakeHub, model: ScriptedModel, extra: { limits?: Partial<Limits>; overrides?: Record<string, string> } = {}): DeptRuntime {
  return new DeptRuntime({
    dept: DEPT,
    hubUrl: "http://hub",
    gatewayUrl: "http://gateway",
    dataDir: hub.dataDir,
    tokens: { dept: "tok_menxia", control: "tok_control" },
    buildTools: testTools,
    streamFn: model.streamFn,
    limits: { ...FAST_LIMITS, ...extra.limits },
    fetchImpl: hub.fetchImpl,
    deptUrlOverrides: extra.overrides,
    logger: () => undefined,
  });
}

export async function until(cond: () => boolean, timeoutMs = 3000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

export const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
