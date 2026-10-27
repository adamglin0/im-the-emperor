// 消息投递：地址校验、风暴限流、部门路由、收件 seq、唤醒判定、span/事件、门铃。
import {
  LIMITS,
  newId,
  type Address,
  type Delivery,
  type Message,
  type MessageKind,
  type Priority,
  type SendMessageReq,
  type SendMessageRes,
} from "@court/shared";
import { bad, HubError, rateLimited, type HubCtx, type MessageService, type Principal } from "../ctx.ts";

export const MESSAGE_KINDS: MessageKind[] = [
  "chat",
  "oral_order",
  "council",
  "edict_notice",
  "task_notice",
  "service_request",
  "service_result",
  "schedule",
  "notification_reply",
  "audit",
  "fyi",
  "system",
];
const PRIORITIES: Priority[] = ["low", "normal", "high", "urgent"];
const COURTESY_RE = /^(收到|谢谢|多谢|好的|遵命|已阅|明白|知悉)/;
const MAX_SUBJECT = 200;
const MAX_BODY = 64 * 1024;
const PAIR_WINDOW_MS = 10 * 60_000;
/** 官员主动致信陛下（非回复陛下来信）每小时上限 */
export const EMPEROR_MSG_PER_HOUR = 10;
/** 部门调用不得使用的系统类消息 */
const SYSTEM_ONLY_KINDS: MessageKind[] = ["notification_reply", "schedule", "system", "oral_order"];

/** 内部发送选项（不对外暴露） */
export interface SendOpts {
  /** 允许投递到空缺职位（系统通知、定时任务：新官到任后可见） */
  allowVacant?: boolean;
}

type Target = { addr: Address; post?: string; emperor?: boolean };

export interface MessageServiceExt extends MessageService {
  sendWith(req: SendMessageReq, principal: Principal | undefined, opts: SendOpts): SendMessageRes;
}

/** 规范化地址：裸 post_id 视为 post:<id> */
export function normalizeAddr(ctx: HubCtx, a: unknown): Address {
  if (typeof a !== "string" || !a.trim()) throw bad("地址不能为空，应为 emperor / post:<职位> / dept:<部门>");
  const s = a.trim();
  if (s === "emperor" || s === "court" || s.includes(":")) return s;
  if (ctx.registry.post(s)) return `post:${s}`;
  if (ctx.registry.dept(s)) return `dept:${s}`;
  throw bad(`非法地址「${s}」，应为 emperor / post:<职位> / dept:<部门>`);
}

export function postIdOf(addr: Address): string | undefined {
  return addr.startsWith("post:") ? addr.slice(5) : undefined;
}

export function createMessages(ctx: HubCtx): MessageServiceExt {
  function getMsg(id: string): Message | undefined {
    return ctx.db.getJson<Message>("SELECT data_json FROM messages WHERE id = ?", id);
  }

  function checkFrom(from: Address, principal: Principal | undefined): void {
    if (from === "emperor") return;
    if (from.startsWith("system:")) {
      if (principal && principal.kind !== "system") throw bad("system:* 地址只能由皇城内部使用");
      return;
    }
    if (from.startsWith("post:")) {
      if (!ctx.registry.post(from.slice(5))) throw bad(`发信职位 ${from} 不存在`);
      return;
    }
    if (from.startsWith("dept:")) {
      if (!ctx.registry.dept(from.slice(5))) throw bad(`发信部门 ${from} 不存在`);
      return;
    }
    throw bad(`非法发信地址「${from}」`);
  }

  /** 解析收件地址 → 实际职位 */
  function resolveTarget(addr: Address, kind: MessageKind, from: Address, opts: SendOpts, role: "to" | "cc"): Target {
    if (addr === "emperor") return { addr, emperor: true };
    if (addr.startsWith("post:")) {
      const id = addr.slice(5);
      if (!ctx.registry.post(id)) throw bad(`${role === "to" ? "收件" : "抄送"}职位 ${addr} 不存在，请用 list_officials 查正确的 post_id`);
      if (!opts.allowVacant && !ctx.registry.officialOf(id)) {
        const dept = ctx.registry.post(id)!.dept;
        throw bad(`职位 ${addr} 目前空缺，无人收信。请改发部门 dept:${dept}`);
      }
      return { addr, post: id };
    }
    if (addr.startsWith("dept:")) {
      const id = addr.slice(5);
      if (!ctx.registry.dept(id)) throw bad(`部门 ${addr} 不存在`);
      const exclude = from.startsWith("post:") ? [from.slice(5)] : [];
      const post = ctx.registry.routeDept(id, kind, { exclude }) ?? ctx.registry.routeDept(id, kind);
      if (!post) throw new HubError(503, "unavailable", `部门 ${addr} 暂无在任官员可收件，请稍后再试或上报`);
      return { addr: `post:${post}`, post };
    }
    if (addr.startsWith("system:")) throw bad("不能给 system:* 地址发信；系统事务请找对应部门");
    throw bad(`非法收件地址「${addr}」`);
  }

  /** 客户端给的 thread_id 仅当该线程已存在且发信人参与其中才沿用，否则另开新线程 */
  function acceptThread(threadId: unknown, from: Address): boolean {
    if (typeof threadId !== "string" || !threadId) return false;
    if (from.startsWith("system:")) return !!ctx.db.get("SELECT 1 FROM messages WHERE thread_id = ? LIMIT 1", threadId);
    const post = postIdOf(from) ?? "";
    return !!ctx.db.get(
      `SELECT 1 FROM messages WHERE thread_id = ? AND (from_addr = ? OR to_addr = ? OR id IN (SELECT message_id FROM deliveries WHERE post_id = ?)) LIMIT 1`,
      threadId,
      from,
      from,
      post,
    );
  }

  function nextSeq(postId: string): number {
    ctx.db.run("INSERT OR IGNORE INTO inbox_cursors (post_id, next_seq, acked_seq) VALUES (?, 1, 0)", postId);
    const row = ctx.db.get<{ next_seq: number }>("SELECT next_seq FROM inbox_cursors WHERE post_id = ?", postId)!;
    ctx.db.run("UPDATE inbox_cursors SET next_seq = next_seq + 1 WHERE post_id = ?", postId);
    return row.next_seq;
  }

  function doSend(req: SendMessageReq, principal: Principal | undefined, opts: SendOpts): SendMessageRes {
    if (!req || typeof req !== "object") throw bad("请求体缺失");
    const kind = req.kind;
    if (!MESSAGE_KINDS.includes(kind)) throw bad(`未知消息类型 kind=${String(kind)}，可选：${MESSAGE_KINDS.join("/")}`);
    if (principal?.kind === "dept") {
      if (SYSTEM_ONLY_KINDS.includes(kind)) throw bad(`消息类型 ${kind} 只能由皇城或陛下发出，请用 chat / fyi`);
      if (kind === "audit" && principal.dept !== "yushitai") throw bad("audit 类消息只能由御史台发出");
    }
    if (typeof req.body !== "string") throw bad("body（正文）必须是字符串");
    if (req.body.length > MAX_BODY) throw bad(`正文过长（${req.body.length} 字符，上限 ${MAX_BODY}）。长内容请存为资产（asset_write）后附上资产 ID`);
    const priority: Priority = req.priority ?? "normal";
    if (!PRIORITIES.includes(priority)) throw bad(`priority 只能是 ${PRIORITIES.join("/")}`);
    const cc = req.cc ?? [];
    if (!Array.isArray(cc)) throw bad("cc 必须是地址数组");
    if (cc.length > LIMITS.broadcastMaxRecipients) {
      throw bad(`抄送人数 ${cc.length} 超过上限 ${LIMITS.broadcastMaxRecipients}。请精简抄送，或改发部门（dept:<部门>）由部门分派`);
    }
    const from = normalizeAddr(ctx, req.from);
    checkFrom(from, principal);
    const toAddr = normalizeAddr(ctx, req.to);
    const subject = String(req.subject ?? "").trim().slice(0, MAX_SUBJECT) || req.body.trim().slice(0, 30) || "（无题）";
    const meta: Record<string, unknown> = req.meta && typeof req.meta === "object" ? { ...req.meta } : {};
    const now = ctx.now();

    const parent = req.reply_to ? getMsg(req.reply_to) : undefined;
    if (req.reply_to && !parent) throw bad(`reply_to 指向的消息 ${req.reply_to} 不存在`);

    // 跳数
    const hop = Math.max(Number(req.parent_hop) || 0, parent?.hop_count ?? 0) + 1;
    if (hop > LIMITS.maxHopCount) {
      throw rateLimited(`这条消息链已转了 ${hop - 1} 手（上限 ${LIMITS.maxHopCount}）。请停止转发/回复，直接自行处理，或用 escalate 上报上级/陛下`);
    }

    const target = resolveTarget(toAddr, kind, from, opts, "to");
    const fromPost = postIdOf(from);
    if (fromPost && target.post === fromPost) throw bad("不能给自己发信。要记事请用 memory_note");

    const thread_id = parent?.thread_id ?? (acceptThread(req.thread_id, from) ? (req.thread_id as string) : newId("th"));
    const trace_id = req.trace_id || parent?.trace_id || newId("tr");

    // 同一对官员同一线程的来回上限（仅官员之间）
    if (fromPost && target.post) {
      const n = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND from_addr = ? AND to_addr = ? AND created_at > ?",
        thread_id,
        from,
        target.addr,
        now - PAIR_WINDOW_MS,
      )!.n;
      if (n >= LIMITS.pairThreadMaxPer10Min) {
        throw rateLimited(
          `你在同一线程 10 分钟内已给 ${target.addr} 发了 ${n} 封信（上限 ${LIMITS.pairThreadMaxPer10Min}）。请停止来回，自行决断；确需裁决请 escalate 上报上级`,
        );
      }
    }

    // 致陛下限流（回复陛下来信不计）
    if (fromPost && (target.emperor || cc.includes("emperor")) && parent?.from !== "emperor") {
      const n = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM messages WHERE from_addr = ? AND to_addr = 'emperor' AND created_at > ?",
        from,
        now - 3600_000,
      )!.n;
      if (n >= EMPEROR_MSG_PER_HOUR) throw rateLimited(`你这一小时已主动致信陛下 ${n} 次（上限 ${EMPEROR_MSG_PER_HOUR}）。请合并成一份奏报，稍后再呈`);
    }

    // 抄送解析（去重，排除主收件人与发信人）
    const ccTargets: Target[] = [];
    const seen = new Set<string>([target.post ?? "", fromPost ?? ""]);
    let ccEmperor = false;
    for (const a of cc) {
      const t = resolveTarget(normalizeAddr(ctx, a), kind, from, opts, "cc");
      if (t.emperor) {
        ccEmperor = true;
        continue;
      }
      if (seen.has(t.post!)) continue;
      seen.add(t.post!);
      ccTargets.push(t);
    }

    // 客套过滤：短客套且无需回复 → 存档不投递
    const courtesy =
      !!fromPost && !req.requires_reply && req.body.trim().length <= 12 && COURTESY_RE.test(req.body.trim());
    if (courtesy) meta.dropped = "courtesy";

    const id = newId("msg");
    const span_id = ctx.events.span({
      trace_id,
      kind: "message",
      name: subject,
      actor: from,
      parent_span_id: req.parent_span_id || undefined,
      status: "ok",
      started_at: now,
      ended_at: now,
      attrs: { message_id: id, to: target.addr, kind, cc: ccTargets.map((t) => t.addr) },
    });
    const message: Message = {
      id,
      from,
      to: target.addr,
      cc: ccTargets.map((t) => t.addr).concat(ccEmperor ? ["emperor"] : []),
      kind,
      subject,
      body: req.body,
      requires_reply: !!req.requires_reply,
      thread_id,
      trace_id,
      span_id,
      priority,
      hop_count: hop,
      created_at: now,
    };
    if (parent) message.reply_to = parent.id;
    if (Object.keys(meta).length) message.meta = meta;

    ctx.db.run(
      `INSERT INTO messages (id, from_addr, to_addr, kind, subject, thread_id, trace_id, reply_to, requires_reply, priority, created_at, data_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      from,
      message.to,
      kind,
      subject,
      thread_id,
      trace_id,
      message.reply_to ?? null,
      message.requires_reply ? 1 : 0,
      priority,
      now,
      JSON.stringify(message),
    );
    if (parent?.span_id) ctx.events.link(parent.span_id, span_id, "message", trace_id, "回复");

    const routed: string[] = [];
    const wakePosts: string[] = [];
    if (!courtesy) {
      const deliveries: { t: Target; role: "to" | "cc" }[] = [];
      if (target.post) deliveries.push({ t: target, role: "to" });
      for (const t of ccTargets) deliveries.push({ t, role: "cc" });
      for (const { t, role } of deliveries) {
        const wakes = role === "to" && kind !== "fyi" && !meta.no_wake;
        const seq = nextSeq(t.post!);
        ctx.db.run(
          "INSERT INTO deliveries (post_id, seq, message_id, wakes, role, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          t.post!,
          seq,
          id,
          wakes ? 1 : 0,
          role,
          now,
        );
        routed.push(t.post!);
        if (wakes) wakePosts.push(t.post!);
      }
    }

    const fromDept = fromPost ? ctx.registry.post(fromPost)?.dept : undefined;
    ctx.events.emit({
      type: "message.sent",
      actor: from,
      dept: fromDept,
      trace_id,
      span_id,
      parent_span_id: req.parent_span_id || undefined,
      subject_type: "message",
      subject_id: id,
      summary: `${from} → ${message.to}：${subject}${courtesy ? "（客套，未投递）" : ""}`,
      data: { to: message.to, cc: message.cc, kind, routed_to: routed, requires_reply: message.requires_reply, wakes: wakePosts },
    });
    if (target.emperor || ccEmperor) {
      ctx.events.emit({
        type: "message.to_emperor",
        actor: from,
        dept: fromDept,
        trace_id,
        span_id,
        subject_type: "message",
        subject_id: id,
        summary: `${from} 致陛下：${subject}`,
        data: { kind, requires_reply: message.requires_reply },
      });
    }
    if (wakePosts.length) ctx.doorbell.ring(wakePosts);
    return { message, routed_to: routed };
  }

  function sendWith(req: SendMessageReq, principal: Principal | undefined, opts: SendOpts): SendMessageRes {
    // 幂等键按发信人隔离，避免不同调用方撞键
    const key = req?.idem_key ? `msg:${typeof req.from === "string" ? req.from : ""}:${req.idem_key}` : undefined;
    return ctx.idem.wrap(key, () => ctx.db.tx(() => doSend(req, principal, opts)));
  }

  const self: MessageServiceExt = {
    send(req: SendMessageReq, principal?: Principal): SendMessageRes {
      return sendWith(req, principal, {});
    },
    sendWith,

    get: getMsg,

    inbox(postId: string, after: number, limit: number) {
      const lim = Math.max(1, Math.min(500, Math.floor(limit) || 100));
      const rows = ctx.db.all<{ post_id: string; seq: number; message_id: string; wakes: number; role: "to" | "cc"; created_at: number; data_json: string }>(
        `SELECT d.post_id, d.seq, d.message_id, d.wakes, d.role, d.created_at, m.data_json
         FROM deliveries d JOIN messages m ON m.id = d.message_id
         WHERE d.post_id = ? AND d.seq > ? ORDER BY d.seq ASC LIMIT ?`,
        postId,
        Math.max(0, Math.floor(after) || 0),
        lim,
      );
      const items = rows.map((r) => {
        const delivery: Delivery = { post_id: r.post_id, seq: r.seq, message_id: r.message_id, wakes: !!r.wakes, role: r.role, created_at: r.created_at };
        return { delivery, message: JSON.parse(r.data_json) as Message };
      });
      return { items, latest_seq: self.latestSeq(postId) };
    },

    ack(postId: string, seq: number): void {
      const s = Math.floor(Number(seq));
      if (!Number.isFinite(s) || s < 0) throw bad("seq 必须是非负整数");
      ctx.db.tx(() => {
        ctx.db.run("INSERT OR IGNORE INTO inbox_cursors (post_id, next_seq, acked_seq) VALUES (?, 1, 0)", postId);
        ctx.db.run("UPDATE inbox_cursors SET acked_seq = MAX(acked_seq, MIN(?, next_seq - 1)) WHERE post_id = ?", s, postId);
      });
    },

    ackedSeq(postId: string): number {
      return ctx.db.get<{ acked_seq: number }>("SELECT acked_seq FROM inbox_cursors WHERE post_id = ?", postId)?.acked_seq ?? 0;
    },

    latestSeq(postId: string): number {
      const r = ctx.db.get<{ next_seq: number }>("SELECT next_seq FROM inbox_cursors WHERE post_id = ?", postId);
      return r ? r.next_seq - 1 : 0;
    },

    thread(threadId: string): Message[] {
      return ctx.db.allJson<Message>(
        "SELECT data_json FROM (SELECT data_json, created_at, rowid AS rid FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 500) ORDER BY created_at ASC, rid ASC",
        threadId,
      );
    },

    notifyPost(postId, kind, subject, body, opts = {}): Message {
      const meta: Record<string, unknown> = { ...(opts.meta ?? {}) };
      if (opts.wakes === false) meta.no_wake = true;
      const res = sendWith(
        {
          from: opts.from ?? "system:hub",
          to: `post:${postId}`,
          kind,
          subject,
          body,
          trace_id: opts.trace_id,
          priority: opts.priority,
          meta,
        },
        undefined,
        { allowVacant: true },
      );
      return res.message;
    },
  };
  return self;
}
