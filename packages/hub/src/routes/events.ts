// 事件上报（部门 outbox）、事件查询、SSE 驿报（/api/stream）。
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { CourtEvent, EventIn } from "@court/shared";
import { bad, forbidden, type HubCtx } from "../ctx.ts";
import { principal, queryInt, readJson } from "../auth.ts";
import { rowToEvent } from "../services/events.ts";

export const SSE_FLUSH_MS = 250;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_REPLAY_MAX = 500;
const SSE_BUFFER_MAX = 2000;

type EventRow = Parameters<typeof rowToEvent>[0];

/** 部门只能以本部门名义上报：actor 须为本部门职位或本部门；span 不得覆盖他部的 */
function assertDeptEvents(ctx: HubCtx, dept: string, events: EventIn[]): void {
  const ownAddr = (a: unknown) =>
    typeof a === "string" && (a === `dept:${dept}` || (a.startsWith("post:") && ctx.registry.post(a.slice(5))?.dept === dept));
  for (const e of events) {
    if (!e) continue;
    if (e.dept && e.dept !== dept) throw forbidden(`部门 ${dept} 不能代他部 ${e.dept} 上报事件`);
    if (!ownAddr(e.actor)) throw forbidden(`事件 actor ${String(e.actor)} 不属于部门 ${dept}`);
    e.dept = dept;
    if (e.span) {
      if (!ownAddr(e.span.actor ?? e.actor)) throw forbidden(`span actor 不属于部门 ${dept}`);
      const prev = ctx.db.get<{ data_json: string }>("SELECT data_json FROM spans WHERE span_id = ?", e.span.span_id);
      if (prev && !ownAddr((JSON.parse(prev.data_json) as { actor: string }).actor)) throw forbidden(`span ${e.span.span_id} 属于他部，不能覆盖`);
    }
  }
}

export function register(app: Hono, ctx: HubCtx): void {
  app.post("/api/events", async (c) => {
    const p = principal(c);
    const body = await readJson<{ events?: EventIn[] }>(c);
    if (!Array.isArray(body.events)) throw bad("events 必须是数组");
    if (body.events.length > 2000) throw bad("单次最多 2000 条事件");
    if (p.kind === "dept") assertDeptEvents(ctx, p.dept!, body.events);
    return c.json({ ok: true as const, inserted: ctx.events.ingest(body.events) });
  });

  app.get("/api/events", (c) => {
    const where: string[] = [];
    const params: (string | number)[] = [];
    for (const k of ["trace_id", "actor", "dept"] as const) {
      const v = c.req.query(k);
      if (v) {
        where.push(`${k} = ?`);
        params.push(v);
      }
    }
    const type = c.req.query("type");
    if (type) {
      // 前缀匹配（不用 LIKE，避免 _ 被当通配符）
      where.push("substr(type, 1, ?) = ?");
      params.push(type.length, type);
    }
    const limit = queryInt(c, "limit", 200, 1, 1000);
    const since = c.req.query("since_id");
    let rows: EventRow[];
    if (since) {
      where.push("id > ?");
      params.push(queryInt(c, "since_id", 0, 0));
      rows = ctx.db.all<EventRow>(`SELECT * FROM events WHERE ${where.join(" AND ")} ORDER BY id ASC LIMIT ?`, ...params, limit);
    } else {
      rows = ctx.db
        .all<EventRow>(`SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`, ...params, limit)
        .reverse();
    }
    return c.json(rows.map(rowToEvent));
  });

  app.get("/api/stream", (c) => {
    const lastHeader = c.req.header("last-event-id") ?? c.req.query("last_event_id");
    const lastId = lastHeader && /^\d+$/.test(lastHeader) ? Number(lastHeader) : undefined;
    return streamSSE(c, async (stream) => {
      let buffer: CourtEvent[] = [];
      let sentId = 0;
      // 先订阅再回放，避免回放与实时之间漏事件
      const unsubscribe = ctx.events.subscribe((e) => {
        buffer.push(e);
        if (buffer.length > SSE_BUFFER_MAX) buffer = buffer.slice(-SSE_BUFFER_MAX); // 慢客户端：丢最旧，可凭 Last-Event-ID 补
      });
      let closed = false;
      const done = new Promise<void>((resolve) => {
        stream.onAbort(() => {
          closed = true;
          resolve();
        });
      });

      const write = async (e: CourtEvent) => {
        // 不入库的轻量事件（id<0）：不带 id 行，不影响 Last-Event-ID 续传
        if (e.id < 0) {
          await stream.writeSSE({ data: JSON.stringify(e) });
          return;
        }
        if (e.id <= sentId) return;
        sentId = e.id;
        await stream.writeSSE({ id: String(e.id), data: JSON.stringify(e) });
      };

      try {
        if (lastId !== undefined) {
          const rows = ctx.db.all<EventRow>("SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT ?", lastId, SSE_REPLAY_MAX);
          for (const r of rows) await write(rowToEvent(r));
        } else {
          // 新连接：以当前最大 id 为起点，避免把缓冲里更早的事件重复推
          sentId = ctx.db.get<{ m: number | null }>("SELECT MAX(id) AS m FROM events")?.m ?? 0;
          buffer = buffer.filter((e) => e.id < 0 || e.id > sentId);
        }
        await stream.write(": connected\n\n");
        let lastBeat = Date.now();
        while (!closed && !stream.aborted) {
          await Promise.race([stream.sleep(SSE_FLUSH_MS), done]);
          if (closed) break;
          if (buffer.length) {
            const batch = buffer;
            buffer = [];
            // 入库事件按 id 排序；轻量事件（id<0）保持到达顺序，排在其后
            const persisted = batch.filter((e) => e.id > 0).sort((a, b) => a.id - b.id);
            for (const e of [...persisted, ...batch.filter((e) => e.id < 0)]) await write(e);
          }
          if (Date.now() - lastBeat >= SSE_HEARTBEAT_MS) {
            lastBeat = Date.now();
            await stream.write(": ping\n\n");
          }
        }
      } catch {
        /* 客户端断开时写入会失败，忽略 */
      } finally {
        unsubscribe();
      }
    });
  });
}
