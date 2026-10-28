// MCP 中转站：授权过滤、调用、鉴权、连接生命周期、HTTP 传输、主机拦截、管理接口。runner=local（不需要 docker）。
import { resolve } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApiError, McpAdminClient, McpClient, type McpInternalState, type McpServerConfig } from "@court/shared";
import { startMcp, type McpHandle } from "../src/server.ts";
import { startFakeHub, type FakeHub } from "./fake-hub.ts";
// @ts-expect-error 夹具为 .mjs，无类型声明
import { startHttpFixture } from "./fixtures/http-server.mjs";

const BROKER_TOKEN = "mc_test_broker_token_000000000001";
const DEPT_TOKENS = { libu: "dk_libu_test_token_0001", hubu: "dk_hubu_test_token_0001" };
const STDIO_FIXTURE = resolve(import.meta.dirname, "fixtures", "stdio-server.mjs");
const SECRET = "s3cr3t-fixture-value";

function stdioServer(id: string, over: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    id,
    name: `夹具 ${id}`,
    description: `测试服务器 ${id}`,
    transport: "stdio",
    enabled: true,
    targets: [{ kind: "all" }],
    command: process.execPath,
    args: [STDIO_FIXTURE],
    env: { FIXTURE_SECRET: SECRET },
    version: 1,
    created_at: 1,
    updated_at: 1,
    updated_by: "emperor",
    ...over,
  };
}

function baseState(servers: McpServerConfig[], version = 1): McpInternalState {
  return {
    version,
    servers,
    tokens: { [DEPT_TOKENS.libu]: "libu", [DEPT_TOKENS.hubu]: "hubu" },
    posts: {
      "libu.shangshu": { dept: "libu", official_id: "off_libu_1" },
      "libu.shilang": { dept: "libu", official_id: "off_libu_2" },
      "hubu.shangshu": { dept: "hubu", official_id: "off_hubu_1" },
    },
  };
}

async function expectApiError(p: Promise<unknown>, status: number, code?: string): Promise<ApiError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ApiError);
  expect((err as ApiError).status).toBe(status);
  if (code) expect((err as ApiError).code).toBe(code);
  return err as ApiError;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(what: string, fn: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const textOf = (res: { content: { type: string; text?: string }[] }) => res.content.map((c) => c.text ?? "").join("");

describe("MCP 中转站（stdio local）", () => {
  let hub: FakeHub;
  let broker: McpHandle;
  let admin: McpAdminClient;
  const as = (post: string, token?: string) =>
    new McpClient({ baseUrl: broker.url, token: token ?? DEPT_TOKENS[post.split(".")[0] as keyof typeof DEPT_TOKENS], actingPost: post, timeoutMs: 30_000 });
  const setState = async (servers: McpServerConfig[], version: number) => {
    hub.state = baseState(servers, version);
    await admin.reload();
  };

  beforeAll(async () => {
    hub = await startFakeHub(BROKER_TOKEN, baseState([]));
    broker = await startMcp({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, token: BROKER_TOKEN, runner: "local", blockedHosts: [], pollMs: 60_000 });
    admin = new McpAdminClient({ baseUrl: broker.url, token: BROKER_TOKEN, timeoutMs: 30_000 });
  });
  afterAll(async () => {
    await broker?.close();
    await hub?.close();
  });

  it("/health 无需鉴权；/admin 需 broker token", async () => {
    const h = await new McpAdminClient({ baseUrl: broker.url }).health();
    expect(h).toMatchObject({ ok: true, runner: "local" });
    await expectApiError(new McpAdminClient({ baseUrl: broker.url, token: "mc_wrong" }).status(), 401, "unauthorized");
    await expectApiError(new McpAdminClient({ baseUrl: broker.url }).reload(), 401, "unauthorized");
    expect(await admin.reload()).toEqual({ ok: true, version: 1 });
  });

  it("目录按授权对象与启用状态过滤", async () => {
    await setState(
      [
        stdioServer("all-srv", { targets: [{ kind: "all" }] }),
        stdioServer("libu-srv", { targets: [{ kind: "dept", id: "libu" }] }),
        stdioServer("person-srv", { targets: [{ kind: "official", id: "off_hubu_1" }] }),
        stdioServer("off-srv", { enabled: false }),
      ],
      2,
    );
    const libu = await as("libu.shangshu").catalog();
    expect(libu.servers.map((s) => s.id)).toEqual(["all-srv", "libu-srv"]);
    expect(libu.servers[0].tools.map((t) => t.name)).toContain("echo");
    expect(libu.servers[0].tools.find((t) => t.name === "echo")?.input_schema).toMatchObject({ type: "object", required: ["text"] });
    const hubu = await as("hubu.shangshu").catalog();
    expect(hubu.servers.map((s) => s.id)).toEqual(["all-srv", "person-srv"]);
    // 指纹稳定；授权的服务器换版本后变化
    expect((await as("libu.shangshu").catalog()).version).toBe(libu.version);
    await setState([stdioServer("all-srv", { version: 2 }), stdioServer("libu-srv", { targets: [{ kind: "dept", id: "libu" }] })], 3);
    expect((await as("libu.shangshu").catalog()).version).not.toBe(libu.version);
    // 未授权的服务器不可调用
    await expectApiError(as("hubu.shangshu").call({ server: "libu-srv", tool: "echo", arguments: { text: "x" } }), 404, "not_found");
  });

  it("调用：成功、is_error、图片、超大图片、密钥环境、未知工具 404", async () => {
    await setState([stdioServer("calls")], 4);
    const c = as("libu.shangshu");
    const ok = await c.call({ server: "calls", tool: "echo", arguments: { text: "你好" } });
    expect(ok).toMatchObject({ is_error: false, content: [{ type: "text", text: "echo:你好" }], structured: { echoed: "你好" } });
    expect(ok.duration_ms).toBeGreaterThanOrEqual(0);
    const bad = await c.call({ server: "calls", tool: "fail", arguments: {} });
    expect(bad).toMatchObject({ is_error: true, content: [{ type: "text", text: "boom" }] });
    const img = await c.call({ server: "calls", tool: "image", arguments: {} });
    expect(img.content[0]).toMatchObject({ type: "image", mimeType: "image/png" });
    const big = await c.call({ server: "calls", tool: "big_image", arguments: {} });
    expect(big.content[0].type).toBe("other");
    expect(textOf(await c.call({ server: "calls", tool: "env", arguments: { key: "FIXTURE_SECRET" } }))).toBe(SECRET);
    await expectApiError(c.call({ server: "calls", tool: "no_such_tool", arguments: {} }), 404, "not_found");
    await expectApiError(c.call({ server: "nope", tool: "echo", arguments: {} }), 404, "not_found");
    const statuses = await admin.status();
    expect(statuses.find((s) => s.id === "calls")).toMatchObject({ state: "ready", tool_count: 8 });
    expect(statuses.find((s) => s.id === "calls")!.calls).toBeGreaterThanOrEqual(5);
  });

  it("tool_allow：目录只给白名单工具，白名单外调用 403", async () => {
    await setState([stdioServer("allow", { tool_allow: ["echo", "pid"] })], 5);
    const cat = await as("libu.shangshu").catalog();
    expect(cat.servers[0].tools.map((t) => t.name).sort()).toEqual(["echo", "pid"]);
    await expectApiError(as("libu.shangshu").call({ server: "allow", tool: "fail", arguments: {} }), 403, "forbidden");
    expect(textOf(await as("libu.shangshu").call({ server: "allow", tool: "echo", arguments: { text: "a" } }))).toBe("echo:a");
  });

  it("部门鉴权：错 token 401、职位不属本部门 403、缺 X-Acting-Post 400；停用 409", async () => {
    await setState([stdioServer("auth"), stdioServer("disabled", { enabled: false })], 6);
    await expectApiError(as("libu.shangshu", "dk_wrong").catalog(), 401, "unauthorized");
    await expectApiError(as("hubu.shangshu", DEPT_TOKENS.libu).catalog(), 403, "forbidden");
    await expectApiError(as("libu.ghost").catalog(), 403, "forbidden");
    await expectApiError(new McpClient({ baseUrl: broker.url, token: DEPT_TOKENS.libu }).catalog(), 400, "bad_request");
    await expectApiError(new McpClient({ baseUrl: broker.url }).catalog(), 401, "unauthorized");
    await expectApiError(as("libu.shangshu").call({ server: "disabled", tool: "echo", arguments: {} }), 409, "invalid_state");
  });

  it("配置版本变化 / 停用 → 关闭旧连接（旧进程退出），下次调用起新进程", async () => {
    await setState([stdioServer("life")], 7);
    const c = as("libu.shangshu");
    const pid1 = Number(textOf(await c.call({ server: "life", tool: "pid", arguments: {} })));
    expect(isAlive(pid1)).toBe(true);
    await setState([stdioServer("life", { version: 2 })], 8);
    await waitUntil("旧进程退出", () => !isAlive(pid1));
    const pid2 = Number(textOf(await c.call({ server: "life", tool: "pid", arguments: {} })));
    expect(pid2).not.toBe(pid1);
    await setState([stdioServer("life", { version: 3, enabled: false })], 9);
    await waitUntil("停用后进程退出", () => !isAlive(pid2));
    expect((await admin.status()).find((s) => s.id === "life")?.state).toBe("disabled");
  });

  it("重启接口：换新进程", async () => {
    await setState([stdioServer("rs")], 10);
    const c = as("libu.shangshu");
    const pid1 = Number(textOf(await c.call({ server: "rs", tool: "pid", arguments: {} })));
    const st = await admin.restart("rs");
    expect(st).toMatchObject({ id: "rs", state: "ready" });
    await waitUntil("旧进程退出", () => !isAlive(pid1));
    const pid2 = Number(textOf(await c.call({ server: "rs", tool: "pid", arguments: {} })));
    expect(pid2).not.toBe(pid1);
    await expectApiError(admin.restart("ghost"), 404, "not_found");
  });

  it("启动失败的服务器不影响整体目录，错误带 stderr，随后进入退避", async () => {
    await setState([stdioServer("good"), stdioServer("broken", { args: [STDIO_FIXTURE, "--fail-start"] })], 11);
    const cat = await as("libu.shangshu").catalog();
    const good = cat.servers.find((s) => s.id === "good")!;
    const broken = cat.servers.find((s) => s.id === "broken")!;
    expect(good.tools.length).toBe(8);
    expect(good.error).toBeUndefined();
    expect(broken.tools).toEqual([]);
    expect(broken.error).toContain("启动失败（测试用）");
    expect(broken.error).not.toContain(SECRET);
    const again = await as("libu.shangshu").catalog();
    expect(again.servers.find((s) => s.id === "broken")!.error).toMatch(/秒后才会重试/);
    await expectApiError(as("libu.shangshu").call({ server: "broken", tool: "echo", arguments: { text: "x" } }), 503, "unavailable");
    expect((await admin.status()).find((s) => s.id === "broken")?.state).toBe("error");
  });

  it("stderr 回显密钥：先抹密钥再截断，截断点落在密钥中间也不漏出半截", async () => {
    const res = await admin.test(stdioServer("leaky", { args: [STDIO_FIXTURE, "--fail-start-echo-secret"] }));
    expect(res.ok).toBe(false);
    expect(res.error).toContain("***");
    expect(res.error).not.toContain(SECRET.slice(-8));
  });

  it("调用超时 → 504；服务器崩溃 → 503 且进入退避", async () => {
    await setState([stdioServer("slowpoke", { timeout_seconds: 1 })], 12);
    const c = as("libu.shangshu");
    await expectApiError(c.call({ server: "slowpoke", tool: "slow", arguments: { ms: 3000 } }), 504, "unavailable");
    expect(textOf(await c.call({ server: "slowpoke", tool: "echo", arguments: { text: "still" } }))).toBe("echo:still");
    await expectApiError(c.call({ server: "slowpoke", tool: "crash", arguments: {} }), 503, "unavailable");
    const err = await expectApiError(c.call({ server: "slowpoke", tool: "echo", arguments: { text: "x" } }), 503, "unavailable");
    expect(err.message).toMatch(/秒后才会重试/);
  });

  it("/admin/test：临时连接列出全部工具后关闭；失败返回 ok:false；草稿形状校验", async () => {
    const res = await admin.test(stdioServer("draft", { tool_allow: ["echo"] }));
    expect(res.ok).toBe(true);
    expect(res.server_info).toEqual({ name: "stdio-fixture", version: "9.9.9" });
    expect(res.tools.length).toBe(8); // 测试不受白名单限制，供 UI 勾选
    const failed = await admin.test(stdioServer("draft", { args: [STDIO_FIXTURE, "--fail-start"] }));
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain("启动失败");
    const missing = await admin.test(stdioServer("draft", { command: "/nonexistent/mcp-binary" }));
    expect(missing.ok).toBe(false);
    await expectApiError(admin.test({ ...stdioServer("draft"), id: "Bad Id!" }), 400, "bad_request");
    // 测试连接不进入状态列表
    expect((await admin.status()).some((s) => s.id === "draft")).toBe(false);
  });

  it("hub 不可达：reload 503，已有配置继续服务", async () => {
    await setState([stdioServer("steady")], 13);
    hub.down = true;
    try {
      await expectApiError(admin.reload(), 503, "unavailable");
      expect(textOf(await as("libu.shangshu").call({ server: "steady", tool: "echo", arguments: { text: "ok" } }))).toBe("echo:ok");
    } finally {
      hub.down = false;
    }
  });

  it("未知 token 触发即时刷新（至多每 5 秒一次）", async () => {
    await setState([stdioServer("fresh")], 14);
    const newToken = "dk_newdept_token_0001";
    hub.state = { ...hub.state, tokens: { ...hub.state.tokens, [newToken]: "bingbu" }, posts: { ...hub.state.posts, "bingbu.shangshu": { dept: "bingbu" } } };
    const before = hub.fetches;
    // 刚 reload 过：5 秒内不再拉取
    await expectApiError(as("bingbu.shangshu", newToken).catalog(), 401);
    expect(hub.fetches).toBe(before);
    await new Promise((r) => setTimeout(r, 5_100));
    const cat = await as("bingbu.shangshu", newToken).catalog();
    expect(cat.servers.map((s) => s.id)).toEqual(["fresh"]);
    expect(hub.fetches).toBe(before + 1);
  }, 15_000);
});

describe("MCP 中转站：stdio 闲置关闭", () => {
  let hub: FakeHub;
  let broker: McpHandle;

  beforeAll(async () => {
    hub = await startFakeHub(BROKER_TOKEN, baseState([stdioServer("idle")]));
    broker = await startMcp({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, token: BROKER_TOKEN, runner: "local", pollMs: 60_000, idleMs: 300 });
    await new McpAdminClient({ baseUrl: broker.url, token: BROKER_TOKEN }).reload();
  });
  afterAll(async () => {
    await broker?.close();
    await hub?.close();
  });

  it("闲置后关闭进程；目录仍用缓存工具（不重启）；再调用时重启", async () => {
    const c = new McpClient({ baseUrl: broker.url, token: DEPT_TOKENS.libu, actingPost: "libu.shangshu" });
    const pid1 = Number(textOf(await c.call({ server: "idle", tool: "pid", arguments: {} })));
    await waitUntil("闲置进程退出", () => !isAlive(pid1));
    const admin = new McpAdminClient({ baseUrl: broker.url, token: BROKER_TOKEN });
    expect((await admin.status())[0].state).toBe("idle");
    const cat = await c.catalog();
    expect(cat.servers[0].tools.length).toBe(8);
    expect((await admin.status())[0].state).toBe("idle");
    const pid2 = Number(textOf(await c.call({ server: "idle", tool: "pid", arguments: {} })));
    expect(pid2).not.toBe(pid1);
  });
});

describe("MCP 中转站：streamable HTTP 与主机拦截", () => {
  const API_KEY = "fixture-api-key-123";
  let hub: FakeHub;
  let broker: McpHandle;
  let fixture: { url: string; close(): Promise<void> };
  let admin: McpAdminClient;

  const httpServer = (id: string, url: string, over: Partial<McpServerConfig> = {}): McpServerConfig => ({
    ...stdioServer(id),
    transport: "streamable_http",
    command: undefined,
    args: undefined,
    env: undefined,
    url,
    headers: { "x-api-key": API_KEY },
    ...over,
  });

  beforeAll(async () => {
    fixture = await startHttpFixture({ apiKey: API_KEY });
    hub = await startFakeHub(BROKER_TOKEN, baseState([]));
    broker = await startMcp({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, token: BROKER_TOKEN, runner: "local", blockedHosts: ["LocalHost", "hub"], pollMs: 60_000 });
    admin = new McpAdminClient({ baseUrl: broker.url, token: BROKER_TOKEN, timeoutMs: 30_000 });
  });
  afterAll(async () => {
    await broker?.close();
    await hub?.close();
    await fixture?.close();
  });
  beforeEach(() => {
    hub.state = baseState([]);
  });

  it("HTTP：带请求头连接、列工具、调用", async () => {
    hub.state = baseState([httpServer("web", fixture.url)], 1);
    await admin.reload();
    const c = new McpClient({ baseUrl: broker.url, token: DEPT_TOKENS.hubu, actingPost: "hubu.shangshu" });
    const cat = await c.catalog();
    expect(cat.servers[0]).toMatchObject({ id: "web" });
    expect(cat.servers[0].error).toBeUndefined();
    expect(cat.servers[0].tools.length).toBe(8);
    const res = await c.call({ server: "web", tool: "echo", arguments: { text: "http" } });
    expect(res).toMatchObject({ is_error: false, content: [{ type: "text", text: "echo:http" }] });
  });

  it("HTTP：服务端会话失效（404）→ 自动开新会话重试一次", async () => {
    const sessionful = await startHttpFixture({ apiKey: API_KEY, sessionful: true });
    try {
      hub.state = baseState([httpServer("websess", sessionful.url)], 2);
      await admin.reload();
      const c = new McpClient({ baseUrl: broker.url, token: DEPT_TOKENS.hubu, actingPost: "hubu.shangshu" });
      expect(textOf(await c.call({ server: "websess", tool: "echo", arguments: { text: "a" } }))).toBe("echo:a");
      expect(sessionful.countSessions()).toBe(1);
      sessionful.expireSessions();
      expect(textOf(await c.call({ server: "websess", tool: "echo", arguments: { text: "b" } }))).toBe("echo:b");
      expect(sessionful.countSessions()).toBe(2);
    } finally {
      await sessionful.close();
    }
  });

  it("HTTP：密钥错误时测试失败，错误信息不含密钥", async () => {
    const res = await admin.test(httpServer("webbad", fixture.url, { headers: { "x-api-key": "wrong-key-value-xyz" } }));
    expect(res.ok).toBe(false);
    expect(res.error).not.toContain("wrong-key-value-xyz");
  });

  it("blockedHosts：主机名大小写不敏感精确匹配，目录给出错误、测试失败", async () => {
    const port = new URL(fixture.url).port;
    hub.state = baseState([httpServer("blocked", `http://localhost:${port}/mcp`), httpServer("ok", fixture.url)], 2);
    await admin.reload();
    const cat = await new McpClient({ baseUrl: broker.url, token: DEPT_TOKENS.libu, actingPost: "libu.shangshu" }).catalog();
    const blocked = cat.servers.find((s) => s.id === "blocked")!;
    expect(blocked.tools).toEqual([]);
    expect(blocked.error).toMatch(/朝廷内部服务/);
    expect(cat.servers.find((s) => s.id === "ok")!.tools.length).toBe(8);
    const t = await admin.test(httpServer("blocked2", "http://HUB:8000/mcp"));
    expect(t.ok).toBe(false);
    expect(t.error).toMatch(/朝廷内部服务/);
  });
});
