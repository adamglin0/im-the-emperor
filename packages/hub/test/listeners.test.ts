import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HubClient } from "@court/shared";
import { startHub, expectStatus, raw, type TestHub } from "./helpers.ts";
import { housekeeping } from "../src/main.ts";
import { resolvePrincipal } from "../src/auth.ts";

describe("双监听：内部 API 与皇帝/Web 端口", () => {
  let hub: TestHub;
  beforeAll(async () => {
    hub = await startHub();
  });
  afterAll(async () => {
    await hub.dispose();
  });

  it("内部端口：无 token 一律 401，不授予皇帝；不托管 Web", async () => {
    expect(hub.url).not.toBe(hub.emperorUrl);
    const r = await raw(hub, "GET", "/api/registry", { port: "internal" });
    expect(r.status).toBe(401);
    expect((await r.json()).code).toBe("unauthorized");
    expect((await raw(hub, "POST", "/api/emperor/halt", { port: "internal", body: { halted: true } })).status).toBe(401);
    expect(hub.ctx.registry.isHalted()).toBe(false);
    expect((await raw(hub, "GET", "/", { port: "internal" })).status).toBe(404);
    expect(() => resolvePrincipal(hub.ctx, undefined, undefined, "internal")).toThrow();
    // 带 token 的照常
    expect((await raw(hub, "GET", "/api/registry", { port: "internal", token: hub.tokens.control })).status).toBe(200);
    // 控制面 token 是系统身份，可调皇帝接口（皇城内部用途）
    expect((await raw(hub, "GET", "/api/emperor/overview", { port: "internal", token: hub.tokens.control })).status).toBe(200);
  });

  it("皇帝端口：无 token 即皇帝，带 token 照常解析；托管 Web", async () => {
    expect((await raw(hub, "GET", "/api/emperor/inbox", { port: "emperor" })).status).toBe(200);
    expect((await raw(hub, "GET", "/", { port: "emperor" })).status).toBe(200);
    const tok = hub.ctx.registry.deptToken("gongbu")!;
    // 部门 token 走皇帝端口也只是部门身份
    expect((await raw(hub, "GET", "/api/emperor/inbox", { port: "emperor", token: tok, post: "gongbu.langzhong" })).status).toBe(403);
    expect((await raw(hub, "GET", "/api/registry", { port: "emperor", token: "bogus" })).status).toBe(401);
    // 皇帝客户端误连内部端口 → 401
    await expectStatus(new HubClient({ baseUrl: hub.url }).overview(), 401);
  });

  it("皇帝端口：浏览器跨站写请求一律拒绝（CSRF），同源照常", async () => {
    const xsite = await raw(hub, "POST", "/api/emperor/halt", { port: "emperor", body: { halted: true }, headers: { "sec-fetch-site": "cross-site", "content-type": "text/plain" } });
    expect(xsite.status).toBe(403);
    expect(hub.ctx.registry.isHalted()).toBe(false);
    expect((await raw(hub, "POST", "/api/providers", { port: "emperor", body: { id: "x" }, headers: { "sec-fetch-site": "same-site" } })).status).toBe(403);
    expect((await raw(hub, "GET", "/api/emperor/inbox", { port: "emperor", headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
    expect((await raw(hub, "POST", "/api/emperor/halt", { port: "emperor", body: { halted: false }, headers: { "sec-fetch-site": "same-origin" } })).status).toBe(200);
  });

  it("thread_id：仅沿用发信人参与过的已有线程，否则另开", async () => {
    const a = hub.as("xingbu.langzhong");
    const first = await a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shangshu", kind: "chat", subject: "x", body: "关于验收标准的疑问" });
    // 参与者（收件人）可沿用
    const reply = await hub.as("xingbu.shangshu").sendMessage({ from: "post:xingbu.shangshu", to: "post:xingbu.langzhong", kind: "chat", subject: "x", body: "按诏书第三条执行", thread_id: first.message.thread_id });
    expect(reply.message.thread_id).toBe(first.message.thread_id);
    // 局外人不能挤进别人的线程
    const outsider = await hub.as("gongbu.langzhong").sendMessage({ from: "post:gongbu.langzhong", to: "post:xingbu.shangshu", kind: "chat", subject: "x", body: "我也想插一句话", thread_id: first.message.thread_id });
    expect(outsider.message.thread_id).not.toBe(first.message.thread_id);
    // 不存在的线程 → 新线程
    const fresh = await a.sendMessage({ from: "post:xingbu.langzhong", to: "post:xingbu.shangshu", kind: "chat", subject: "x", body: "另起一个话题来谈", thread_id: "th_made_up" });
    expect(fresh.message.thread_id).not.toBe("th_made_up");
  });

  it("清理：两天前的预算告警标记被删除", () => {
    const now = hub.clock.t;
    hub.ctx.db.run("INSERT INTO meta (k, v) VALUES (?, ?)", "budget_alert:post:x:1", String(now - 3 * 86_400_000));
    hub.ctx.db.run("INSERT INTO meta (k, v) VALUES (?, ?)", "budget_alert:post:x:2", String(now - 3600_000));
    housekeeping(hub.ctx);
    expect(hub.ctx.db.get("SELECT 1 FROM meta WHERE k = 'budget_alert:post:x:1'")).toBeUndefined();
    expect(hub.ctx.db.get("SELECT 1 FROM meta WHERE k = 'budget_alert:post:x:2'")).toBeTruthy();
    expect(hub.ctx.db.get("SELECT 1 FROM meta WHERE k = 'registry_version'")).toBeTruthy();
  });
});
