import { afterEach, describe, expect, it } from "vitest";
import type { DeptRuntime } from "../src/runtime.ts";
import { createDeptApp } from "../src/server.ts";
import { FakeHub, POST, makeRuntime, scriptedModel, tmpDataDir, toolCallMsg, until } from "./helpers.ts";

let rt: DeptRuntime | undefined;
afterEach(async () => {
  await rt?.stop(1000);
  rt = undefined;
});

async function setup() {
  const hub = new FakeHub(tmpDataDir());
  const model = scriptedModel();
  rt = makeRuntime(hub, model);
  await rt.start();
  const app = createDeptApp(rt, { hubUrl: "http://hub", controlToken: "tok_control", fetchImpl: hub.fetchImpl });
  return { hub, model, app, rt };
}

describe("部门/官员 API", () => {
  it("官员门面：转发调用方身份给 hub，成功后本地唤醒", async () => {
    const { hub, model, app } = await setup();
    model.push(toolCallMsg("end_turn", { note: "阅" }));
    const res = await app.request(`/officials/${POST}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok_zhongshu", "x-acting-post": "zhongshu.sheren_a" },
      body: JSON.stringify({ from: "post:zhongshu.sheren_a", kind: "chat", subject: "请审", body: "草稿", idem_key: "k1" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.routed_to).toEqual([POST]);
    expect(hub.sent[0].req.to).toBe(`post:${POST}`);
    expect(hub.sent[0].req.idem_key).toBe("k1");
    expect(hub.sent[0].headers.authorization).toBe("Bearer tok_zhongshu");
    expect(hub.sent[0].headers["x-acting-post"]).toBe("zhongshu.sheren_a");
    await until(() => model.calls.length === 1);
  });

  it("非本部门职位 404；控制面需 token；门铃唤醒", async () => {
    const { hub, model, app } = await setup();
    expect((await app.request("/officials/zhongshu.sheren_a/status")).status).toBe(404);
    expect((await app.request("/control/doorbell", { method: "POST", body: JSON.stringify({ posts: [POST] }) })).status).toBe(401);
    hub.addMessage(POST, { from: "emperor", body: "召见" });
    model.push(toolCallMsg("end_turn", { note: "毕" }));
    const ok = await app.request("/control/doorbell", {
      method: "POST",
      headers: { authorization: "Bearer tok_control", "content-type": "application/json" },
      body: JSON.stringify({ posts: [POST] }),
    });
    expect(ok.status).toBe(200);
    await until(() => model.calls.length === 1);
  });

  it("健康、状态、上下文、日志、人工唤醒", async () => {
    const { model, app } = await setup();
    const h = await app.request("/health");
    expect(h.status).toBe(200);
    const st = (await (await app.request(`/officials/${POST}/status`)).json()) as any;
    expect(st.post_id).toBe(POST);
    expect(st.state).toBe("idle");
    const ctx = (await (await app.request(`/officials/${POST}/context`)).json()) as any;
    expect(ctx.system_prompt).toContain("给事中");
    model.push(toolCallMsg("end_turn", { note: "毕" }));
    const w = await app.request(`/officials/${POST}/wake`, { method: "POST", body: JSON.stringify({ reason: "陛下召见" }) });
    expect(w.status).toBe(200);
    await until(() => model.calls.length === 1);
    const log = (await (await app.request(`/officials/${POST}/log?tail=50`)).json()) as any[];
    expect(log.some((r) => r.type === "turn_start" && String(r.wake_reason).startsWith("manual"))).toBe(true);
    const dept = (await (await app.request("/dept")).json()) as any;
    expect(dept.dept.id).toBe("menxia");
  });
});

describe("startDept（真实端口）", () => {
  it("起服务、经 DeptClient 投递、优雅关闭", async () => {
    const { serve } = await import("@hono/node-server");
    const { DeptClient } = await import("@court/shared");
    const { startDept } = await import("../src/main.ts");
    const { testTools, FAST_LIMITS } = await import("./helpers.ts");
    const hub = new FakeHub(tmpDataDir());
    const hubServer = await new Promise<{ close(cb: () => void): void; port: number }>((resolve) => {
      const s = serve({ fetch: hub.app.fetch, port: 0, hostname: "127.0.0.1" }, (info) => resolve(Object.assign(s, { port: info.port }) as any));
    });
    const model = scriptedModel();
    model.push(toolCallMsg("end_turn", { note: "阅" }));
    const handle = await startDept({
      dept: "menxia",
      hubUrl: `http://127.0.0.1:${hubServer.port}`,
      gatewayUrl: "http://127.0.0.1:9",
      dataDir: hub.dataDir,
      port: 0,
      hostname: "127.0.0.1",
      tokens: { dept: "tok_menxia", control: "tok_control" },
      streamFn: model.streamFn,
      buildTools: testTools,
      limits: FAST_LIMITS,
    });
    try {
      const health = await fetch(`${handle.url}/health`);
      expect(health.status).toBe(200);
      const dc = new DeptClient({ baseUrl: handle.url, token: "tok_zhongshu", actingPost: "zhongshu.sheren_a" });
      const res = await dc.sendToOfficial(POST, { from: "post:zhongshu.sheren_a", kind: "chat", subject: "请审", body: "草稿" });
      expect(res.routed_to).toEqual([POST]);
      await until(() => model.calls.length === 1 && hub.acks.length === 1);
      expect(hub.sent[0].headers.authorization).toBe("Bearer tok_zhongshu");
      const st = await dc.officialStatus(POST);
      expect(st.post_id).toBe(POST);
    } finally {
      await handle.close();
      await new Promise<void>((r) => hubServer.close(() => r()));
    }
    // 关闭后 outbox 已刷到 hub
    expect(hub.events.some((e) => e.type === "turn.end")).toBe(true);
  });
});
