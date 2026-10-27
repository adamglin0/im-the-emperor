import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CourtEvent, OfficialStatus } from "@court/shared";
import { startHub, expectStatus, raw, deadDeptOverrides, type TestHub } from "./helpers.ts";

/** 读取 SSE 流直到拿到满足条件的事件 */
async function readSse(res: Response, until: (evs: CourtEvent[]) => boolean, timeoutMs = 4000): Promise<{ events: CourtEvent[]; ids: string[] }> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const events: CourtEvent[] = [];
  const ids: string[] = [];
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline && !until(events)) {
      const r = await Promise.race([reader.read(), new Promise<{ done: true; value: undefined }>((ok) => setTimeout(() => ok({ done: true, value: undefined }), deadline - Date.now()))]);
      if (r.done) break;
      buf += dec.decode(r.value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        for (const line of block.split("\n")) {
          if (line.startsWith("data: ")) events.push(JSON.parse(line.slice(6)));
          if (line.startsWith("id: ")) ids.push(line.slice(4));
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { events, ids };
}

describe("事件、SSE、心跳、皇帝核心、实时代理", () => {
  let hub: TestHub;
  let dept: Server;
  const seen: { method: string; url: string; auth?: string; body: string }[] = [];

  beforeAll(async () => {
    // 假部门：记录请求，提供 context/log/stream/dept 接口
    dept = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body });
        if (req.url!.endsWith("/stream")) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"type":"thinking","text":"臣思之"}\n\n');
          setTimeout(() => res.end(), 50);
          return;
        }
        res.writeHead(200, { "content-type": "application/json" });
        if (req.url!.includes("/context")) res.end(JSON.stringify({ system_prompt: "sp", messages: [], context_tokens: 42 }));
        else if (req.url!.includes("/log")) res.end(JSON.stringify([{ type: "turn_start", q: req.url }]));
        else if (req.url === "/dept") res.end(JSON.stringify({ dept: { id: "zhongshu" }, officials: [] }));
        else res.end(JSON.stringify({ ok: true }));
      });
    });
    await new Promise<void>((ok) => dept.listen(0, "127.0.0.1", ok));
    const port = (dept.address() as AddressInfo).port;
    process.env.DEPT_URL_OVERRIDES = deadDeptOverrides({ zhongshu: `http://127.0.0.1:${port}` });
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
    dept.closeAllConnections();
    await new Promise<void>((ok) => dept.close(() => ok()));
    delete process.env.DEPT_URL_OVERRIDES;
  });

  it("事件上报（含 span upsert）、去重、查询", async () => {
    const tok = hub.ctx.registry.deptToken("zhongshu")!;
    const c = hub.as("zhongshu.sheren_a");
    const ev = {
      uid: "zhongshu:e1",
      ts: hub.clock.t,
      type: "turn.start",
      actor: "post:zhongshu.sheren_a",
      trace_id: "tr_x1",
      span_id: "sp_turn1",
      summary: "开始一轮",
      span: { span_id: "sp_turn1", trace_id: "tr_x1", kind: "turn" as const, name: "轮次", actor: "post:zhongshu.sheren_a", status: "running" as const, started_at: hub.clock.t },
    };
    expect((await c.postEvents([ev, ev])).inserted).toBe(1);
    expect((await c.postEvents([ev])).inserted).toBe(0);
    await c.postEvents([{ ...ev, uid: "zhongshu:e2", type: "turn.end", span: { ...ev.span, status: "ok", ended_at: hub.clock.t + 5 } }]);
    const sp = hub.ctx.db.getJson<{ status: string; ended_at: number }>("SELECT data_json FROM spans WHERE span_id = 'sp_turn1'")!;
    expect(sp.status).toBe("ok");
    const list = await hub.emperor.events({ trace_id: "tr_x1" });
    expect(list.map((e) => e.type)).toEqual(["turn.start", "turn.end"]);
    expect(list[0].dept).toBe("zhongshu");
    // 不能代他部上报
    expect((await raw(hub, "POST", "/api/events", { token: tok, body: { events: [{ ...ev, uid: "z3", dept: "menxia" }] } })).status).toBe(403);
  });

  it("SSE：实时推送与 Last-Event-ID 回放", async () => {
    const res = await fetch(`${hub.emperorUrl}/api/stream`);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    setTimeout(() => {
      hub.ctx.events.emit({ type: "test.ping", actor: "system:test", summary: "测试一" });
    }, 100);
    const got = await readSse(res, (evs) => evs.some((e) => e.type === "test.ping"));
    const ping = got.events.find((e) => e.type === "test.ping")!;
    expect(got.ids).toContain(String(ping.id));

    hub.ctx.events.emit({ type: "test.after", actor: "system:test", summary: "测试二" });
    const res2 = await fetch(`${hub.emperorUrl}/api/stream`, { headers: { "last-event-id": String(ping.id) } });
    const got2 = await readSse(res2, (evs) => evs.some((e) => e.type === "test.after"));
    expect(got2.events[0].id).toBeGreaterThan(ping.id);
    expect(got2.events.some((e) => e.type === "test.after")).toBe(true);
  });

  it("心跳与状态：在线/离线/空缺；返回罢朝与名册版本", async () => {
    const c = hub.as("zhongshu.sheren_a");
    const st: OfficialStatus = { post_id: "zhongshu.sheren_a", dept: "zhongshu", state: "thinking", last_progress_at: hub.clock.t, turns_last_hour: 1, tokens_today: 10, updated_at: 0 };
    const other: OfficialStatus = { ...st, post_id: "menxia.shilang", dept: "menxia" };
    const r = await c.heartbeat([st, other]);
    expect(r).toMatchObject({ ok: true, halted: false, registry_version: hub.ctx.registry.version() });
    let all = await hub.emperor.statuses();
    expect(all.find((s) => s.post_id === "zhongshu.sheren_a")!.state).toBe("thinking");
    expect(all.find((s) => s.post_id === "menxia.shilang")!.state).toBe("offline"); // 他部的心跳不被接受
    expect(hub.ctx.doorbell.deptHealth().zhongshu.ok).toBe(true);
    hub.clock.t += 31_000;
    all = await hub.emperor.statuses();
    expect(all.find((s) => s.post_id === "zhongshu.sheren_a")!.state).toBe("offline");
  });

  it("口谕/私聊、皇帝来信、私聊记录、总览、罢朝控制面", async () => {
    const r = await hub.emperor.emperorOral({ to: "post:zhongshu.shilang", content: "速拟一道减税诏书" });
    expect(r.message).toMatchObject({ from: "emperor", kind: "oral_order", priority: "high" });
    const chat = await hub.emperor.emperorOral({ to: "post:zhongshu.shilang", content: "卿近来可好？", requires_reply: true });
    expect(chat.message.kind).toBe("chat");
    await hub.as("zhongshu.shilang").sendMessage({ from: "post:zhongshu.shilang", to: "emperor", kind: "chat", subject: "回禀", body: "臣一切安好，谢陛下垂询。", reply_to: chat.message.id });
    const conv = await hub.emperor.emperorChat("zhongshu.shilang");
    expect(conv.map((m) => m.from)).toEqual(["emperor", "emperor", "post:zhongshu.shilang"]);
    await expectStatus(hub.as("zhongshu.shilang").emperorOral({ to: "post:menxia.shilang", content: "冒充" }), 403);

    // 门铃送达假部门
    await new Promise((ok) => setTimeout(ok, 100));
    const bell = seen.find((s) => s.url === "/control/doorbell");
    expect(bell?.auth).toBe(`Bearer ${hub.tokens.control}`);
    expect(JSON.parse(bell!.body).posts).toContain("zhongshu.shilang");

    const ov = await hub.emperor.overview();
    expect(ov.halted).toBe(false);
    expect(ov.statuses.length).toBe(hub.ctx.court.posts.length);
    expect(Object.keys(ov.depts_health)).toHaveLength(11);

    seen.length = 0;
    expect(await hub.emperor.halt(true)).toEqual({ halted: true });
    await new Promise((ok) => setTimeout(ok, 100));
    expect(seen.some((s) => s.url === "/control/pause")).toBe(true);
    expect((await hub.as("zhongshu.sheren_a").heartbeat([])).halted).toBe(true);
    await hub.emperor.halt(false);
  });

  it("实时代理：context / log / stream / wake / compact / dept", async () => {
    const ctxRes = await raw(hub, "GET", "/api/live/zhongshu.sheren_a/context");
    expect(await ctxRes.json()).toMatchObject({ context_tokens: 42 });
    const log = await (await raw(hub, "GET", "/api/live/zhongshu.sheren_a/log?tail=5")).json();
    expect(log[0].q).toContain("tail=5");
    const stream = await raw(hub, "GET", "/api/live/zhongshu.sheren_a/stream");
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(await stream.text()).toContain("臣思之");
    expect((await raw(hub, "POST", "/api/live/zhongshu.sheren_a/wake", { body: { reason: "召见" } })).status).toBe(200);
    expect(seen.some((s) => s.url === "/officials/zhongshu.sheren_a/wake" && s.body.includes("召见"))).toBe(true);
    expect((await raw(hub, "POST", "/api/live/zhongshu.sheren_a/compact", { body: {} })).status).toBe(200);
    expect(seen.some((s) => s.url === "/control/compact/zhongshu.sheren_a")).toBe(true);
    expect(await (await raw(hub, "GET", "/api/live/depts/zhongshu")).json()).toMatchObject({ dept: { id: "zhongshu" } });
    // 不可达部门 → 503
    const dead = await raw(hub, "GET", "/api/live/menxia.shilang/context");
    expect(dead.status).toBe(503);
    expect((await dead.json()).code).toBe("unavailable");
  });
});
