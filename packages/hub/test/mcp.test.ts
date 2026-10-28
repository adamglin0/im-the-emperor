// MCP 服务器配置：CRUD、校验、密钥只写不读、版本冲突、官员审批（只收缩直接生效）、授权解析、broker/部门通知、内部状态鉴权。
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { HubClient, type McpServerConfig, type McpServerInput, type McpWriteRes } from "@court/shared";
import { deadDeptOverrides, expectStatus, raw, startHub, type TestHub } from "./helpers.ts";

const SECRET = "sk-super-secret-value-123";
const SECRET2 = "tok-another-secret-456";

interface Rec {
  method: string;
  path: string;
  auth?: string;
  body: unknown;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const ch of req) chunks.push(ch as Buffer);
  const t = Buffer.concat(chunks).toString("utf8");
  return t ? JSON.parse(t) : undefined;
}

/** 假 broker 与假部门控制面：记录收到的请求 */
async function fakeServer(handler: (r: Rec) => { status?: number; body: unknown }): Promise<{ url: string; got: Rec[]; close(): Promise<void>; server: Server }> {
  const got: Rec[] = [];
  const server = createServer(async (req, res) => {
    const r: Rec = { method: req.method ?? "", path: req.url ?? "", auth: req.headers.authorization, body: await readBody(req) };
    got.push(r);
    const out = handler(r);
    res.writeHead(out.status ?? 200, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    got,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

const waitFor = async (cond: () => boolean, ms = 3000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 10));
  }
};

const httpInput = (id: string, extra: Partial<McpServerInput> = {}): McpServerInput => ({
  id,
  name: `服务 ${id}`,
  transport: "streamable_http",
  url: "https://mcp.example.com/mcp",
  headers: { Authorization: `Bearer ${SECRET}` },
  targets: [{ kind: "all" }],
  ...extra,
});

const applied = (r: McpWriteRes) => {
  if (r.status !== "applied") throw new Error(`期望 applied，实际 ${r.status}`);
  return r.server;
};

let hub: TestHub;
let broker: Awaited<ReturnType<typeof fakeServer>>;
let dept: Awaited<ReturnType<typeof fakeServer>>;
let brokerStatus = 200;
/** 假 broker 认的令牌（启动时取 hub 的真令牌） */
let brokerToken = "";

beforeAll(async () => {
  hub = await startHub();
  brokerToken = hub.ctx.mcpToken;
  broker = await fakeServer((r) => {
    if (r.auth !== `Bearer ${brokerToken}`) return { status: 401, body: { error: "bad token", code: "unauthorized" } };
    if (brokerStatus !== 200) return { status: brokerStatus, body: { error: "boom", code: "internal" } };
    if (r.path === "/admin/reload") return { body: { ok: true, version: 1 } };
    if (r.path === "/admin/status") return { body: [{ id: "x", version: 1, state: "ready", tool_count: 2 }] };
    if (r.path === "/admin/test") return { body: { ok: true, tools: [{ name: "t1", description: "d", input_schema: {} }], duration_ms: 5 } };
    const m = /^\/admin\/servers\/([^/]+)\/restart$/.exec(r.path);
    if (m) return { body: { id: m[1], version: 1, state: "connecting" } };
    return { status: 404, body: { error: "nf", code: "not_found" } };
  });
  dept = await fakeServer(() => ({ body: { ok: true } }));
  hub.ctx.mcpUrl = broker.url;
  process.env.DEPT_URL_OVERRIDES = deadDeptOverrides({ bingbu: dept.url });
});

afterAll(async () => {
  await new Promise((r) => setTimeout(r, 50));
  await hub.dispose();
  await broker.close();
  await dept.close();
  delete process.env.DEPT_URL_OVERRIDES;
});

beforeEach(() => {
  brokerStatus = 200;
});

describe("令牌", () => {
  it("broker token 只写 hub/tokens.json，不写 shared", () => {
    const shared = JSON.parse(readFileSync(join(hub.dataDir, "shared", "tokens.json"), "utf8"));
    const own = JSON.parse(readFileSync(join(hub.dataDir, "hub", "tokens.json"), "utf8"));
    expect(shared.mcp).toBeUndefined();
    expect(JSON.stringify(shared)).not.toContain(hub.ctx.mcpToken);
    expect(own.mcp).toBe(hub.ctx.mcpToken);
    expect(hub.ctx.mcpToken).toMatch(/^mc_[0-9a-f]{48}$/);
  });
});

describe("皇帝 CRUD", () => {
  it("新建、读取、列表；视图不含密钥", async () => {
    const s = applied(await hub.emperor.createMcpServer(httpInput("alpha")));
    expect(s).toMatchObject({ id: "alpha", transport: "streamable_http", enabled: true, header_keys: ["Authorization"], env_keys: [] });
    expect(s.version).toBeGreaterThan(0);
    const one = await hub.emperor.mcpServer("alpha");
    const list = await hub.emperor.mcpServers();
    expect(list.map((x) => x.id)).toContain("alpha");
    for (const body of [s, one, list]) expect(JSON.stringify(body)).not.toContain(SECRET);
    // 原始响应同样不含
    const r = await raw(hub, "GET", "/api/mcp/servers/alpha");
    expect(await r.text()).not.toContain(SECRET);
    // 事件不含密钥
    const ev = hub.ctx.db.all<{ summary: string; data_json: string }>("SELECT summary, data_json FROM events WHERE type LIKE 'mcp.%'");
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) expect(e.summary + (e.data_json ?? "")).not.toContain(SECRET);
  });

  it("修改：null 沿用旧密钥、缺省字段不改、未出现的键删除", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("beta", { headers: { Authorization: SECRET, "X-Extra": SECRET2 } })));
    // 只改名：密钥不变
    applied(await hub.emperor.updateMcpServer("beta", { name: "改名" }));
    let cfg = hub.ctx.mcp.getServer("beta");
    expect(cfg.headers).toEqual({ Authorization: SECRET, "X-Extra": SECRET2 });
    // null = 沿用；X-Extra 未出现 → 删除；新键
    const v = applied(await hub.emperor.updateMcpServer("beta", { headers: { Authorization: null, "X-New": "n" } }));
    cfg = hub.ctx.mcp.getServer("beta");
    expect(cfg.headers).toEqual({ Authorization: SECRET, "X-New": "n" });
    expect(v.header_keys).toEqual(["Authorization", "X-New"]);
    // null 用在不存在的键 → 400
    await expectStatus(hub.emperor.updateMcpServer("beta", { headers: { Nope: null } }), 400);
    // 无变化 → 不 bump
    const before = hub.ctx.mcp.version();
    applied(await hub.emperor.updateMcpServer("beta", { name: "改名" }));
    expect(hub.ctx.mcp.version()).toBe(before);
  });

  it("切换 transport 清掉另一种字段；stdio 缺省值", async () => {
    const s = applied(await hub.emperor.updateMcpServer("beta", { transport: "stdio", command: "npx", args: ["-y", "pkg"], env: { API_KEY: SECRET } }));
    expect(s).toMatchObject({ transport: "stdio", image: "node:24-slim", network: "bridge", memory_mb: 512, cpus: 1, env_keys: ["API_KEY"], header_keys: [] });
    const cfg = hub.ctx.mcp.getServer("beta");
    expect(cfg.url).toBeUndefined();
    expect(cfg.headers).toBeUndefined();
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("expected_version 不符 → 409", async () => {
    const cur = await hub.emperor.mcpServer("alpha");
    await expectStatus(hub.emperor.updateMcpServer("alpha", { name: "x", expected_version: cur.version - 1 }), 409);
    applied(await hub.emperor.updateMcpServer("alpha", { name: "x", expected_version: cur.version }));
    await expectStatus(hub.emperor.deleteMcpServer("alpha", { expected_version: cur.version }), 409);
  });

  it("删除；再删 404", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("gamma")));
    expect(await hub.emperor.deleteMcpServer("gamma", { reason: "不用了" })).toEqual({ status: "deleted", id: "gamma" });
    await expectStatus(hub.emperor.deleteMcpServer("gamma"), 404);
    await expectStatus(hub.emperor.mcpServer("gamma"), 404);
  });

  it("idem_key 重放返回首次结果", async () => {
    const a = await hub.emperor.createMcpServer({ ...httpInput("idem1"), idem_key: "k1" });
    const b = await hub.emperor.createMcpServer({ ...httpInput("idem1"), idem_key: "k1" });
    expect(b).toEqual(a);
  });
});

describe("校验", () => {
  const cases: [string, McpServerInput][] = [
    ["id 不合法", httpInput("Bad ID")],
    ["name 为空", httpInput("v1", { name: "" })],
    ["name 过长", httpInput("v2", { name: "x".repeat(61) })],
    ["transport 非法", httpInput("v3", { transport: "ws" as never })],
    ["url 非 http", httpInput("v4", { url: "ftp://x" })],
    ["header 键非法", httpInput("v5", { headers: { "bad key": "x" } })],
    ["新建时 null 密钥", httpInput("v6", { headers: { A: null } })],
    ["部门不存在", httpInput("v7", { targets: [{ kind: "dept", id: "nope" }] })],
    ["官员不存在", httpInput("v8", { targets: [{ kind: "official", id: "of_nope" }] })],
    ["timeout 越界", httpInput("v9", { timeout_seconds: 601 })],
    ["stdio 无 command", { id: "v10", name: "n", transport: "stdio", targets: [] }],
    ["stdio 镜像非法", { id: "v11", name: "n", transport: "stdio", command: "npx", image: "bad image!", targets: [] }],
    ["env 键非法", { id: "v12", name: "n", transport: "stdio", command: "npx", env: { "1BAD": "x" }, targets: [] }],
    ["network 非法", { id: "v13", name: "n", transport: "stdio", command: "npx", network: "host" as never, targets: [] }],
    ["内存越界", { id: "v14", name: "n", transport: "stdio", command: "npx", memory_mb: 999999, targets: [] }],
    ["args 过多", { id: "v15", name: "n", transport: "stdio", command: "npx", args: Array(65).fill("a"), targets: [] }],
  ];
  for (const [label, input] of cases) {
    it(label, async () => {
      const e = await expectStatus(hub.emperor.createMcpServer(input), 400);
      expect(e.message.length).toBeGreaterThan(4);
    });
  }

  it("重复 id → 409", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("dup")));
    await expectStatus(hub.emperor.createMcpServer(httpInput("dup")), 409);
  });

  for (const key of ["PATH", "home", "npm_config_cache", "UV_CACHE_DIR", "DOCKER_HOST", "docker_config"]) {
    it(`环境变量保留名 ${key} → 400`, async () => {
      const e = await expectStatus(hub.emperor.createMcpServer({ id: "envres", name: "n", transport: "stdio", command: "npx", env: { [key]: "x" }, targets: [] }), 400);
      expect(e.message).toContain("保留名");
    });
  }

  it("密钥键名不能取到原型属性（constructor/__proto__）", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("proto")));
    // null 沿用：base 上没有 constructor 这个自有键 → 400，而不是取到 Object 构造函数
    await expectStatus(hub.emperor.updateMcpServer("proto", { headers: { Authorization: null, constructor: null } }), 400);
    const r = await raw(hub, "PATCH", "/api/mcp/servers/proto", { body: JSON.parse('{"headers":{"__proto__":"x"}}') });
    expect(r.status).toBe(400);
    expect(hub.ctx.mcp.getServer("proto").headers).toEqual({ Authorization: `Bearer ${SECRET}` });
  });

  it("授权对象去重", async () => {
    const s = applied(await hub.emperor.createMcpServer(httpInput("dedup", { targets: [{ kind: "all" }, { kind: "all" }, { kind: "dept", id: "bingbu" }, { kind: "dept", id: "bingbu" }] })));
    expect(s.targets).toEqual([{ kind: "all" }, { kind: "dept", id: "bingbu" }]);
  });
});

describe("官员权限与审批", () => {
  it("无 mcp_admin 的官员 → 403；网关 → 403", async () => {
    const c = hub.as("bingbu.zhifang_langzhong");
    await expectStatus(c.mcpServers(), 403);
    await expectStatus(c.createMcpServer(httpInput("nope1")), 403);
    await expectStatus(c.updateMcpServer("dup", { enabled: false }), 403);
    await expectStatus(c.deleteMcpServer("dup"), 403);
    await expectStatus(hub.gateway.mcpServers(), 403);
  });

  it("吏部尚书（config/court.yaml 授 mcp_admin）可读列表，视图无密钥", async () => {
    expect(hub.ctx.registry.hasTool("libu.shangshu", "mcp_list_servers")).toBe(true);
    const list = await hub.as("libu.shangshu").mcpServers();
    expect(list.length).toBeGreaterThan(0);
    expect(JSON.stringify(list)).not.toContain(SECRET);
  });

  it("官员新建 → 待批；陛下准 → 生效；待批记录与待办不含密钥", async () => {
    const r = await hub.as("libu.shangshu").createMcpServer({ ...httpInput("offnew", { headers: { Authorization: SECRET2 } }), reason: "需要查资料" });
    expect(r.status).toBe("pending_approval");
    if (r.status !== "pending_approval") return;
    expect(hub.ctx.mcp.getServerOrNull("offnew")).toBeUndefined();
    const approvals = await hub.as("bingbu.zhifang_langzhong").approvals("pending");
    expect(JSON.stringify(approvals)).not.toContain(SECRET2);
    const n = await hub.emperor.notification(r.notification_id);
    expect(JSON.stringify(n)).not.toContain(SECRET2);
    expect(n.body).toContain("Authorization");
    await hub.emperor.resolveNotification(r.notification_id, { option: "approve" });
    const cfg = hub.ctx.mcp.getServer("offnew");
    expect(cfg.headers).toEqual({ Authorization: SECRET2 });
    expect(cfg.updated_by).toBe("post:libu.shangshu");
    // 暂存配置已清理
    expect(hub.ctx.db.get("SELECT 1 FROM meta WHERE k = ?", `mcp_pending:${r.approval_id}`)).toBeUndefined();
  });

  it("驳回 → 不生效，暂存清理", async () => {
    const r = await hub.as("libu.shangshu").createMcpServer(httpInput("offrej"));
    if (r.status !== "pending_approval") throw new Error("应待批");
    await hub.emperor.resolveNotification(r.notification_id, { option: "reject" });
    expect(hub.ctx.mcp.getServerOrNull("offrej")).toBeUndefined();
    expect(hub.ctx.db.get("SELECT 1 FROM meta WHERE k = ?", `mcp_pending:${r.approval_id}`)).toBeUndefined();
  });

  it("只收缩（停用、移除授权、缩小白名单、改名/说明/超时）直接生效", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("shrink", { targets: [{ kind: "all" }, { kind: "dept", id: "bingbu" }], tool_allow: ["a", "b"] })));
    const off = hub.as("libu.shangshu");
    const s = applied(await off.updateMcpServer("shrink", { enabled: false, targets: [{ kind: "dept", id: "bingbu" }], tool_allow: ["a"], name: "新名", description: "说明", timeout_seconds: 300 }));
    expect(s).toMatchObject({ enabled: false, targets: [{ kind: "dept", id: "bingbu" }], tool_allow: ["a"], name: "新名", timeout_seconds: 300 });
    // 从「全部」缩到白名单也算收缩
    applied(await hub.emperor.createMcpServer(httpInput("shrink2")));
    applied(await off.updateMcpServer("shrink2", { tool_allow: ["only"] }));
    // 密钥键沿用（值 null）不算改连接
    applied(await off.updateMcpServer("shrink2", { headers: { Authorization: null }, name: "仍可改名" }));
  });

  const expanding: [string, McpServerInput][] = [
    ["启用", { enabled: true }],
    ["新增授权对象", { targets: [{ kind: "dept", id: "bingbu" }, { kind: "all" }] }],
    ["白名单放宽", { tool_allow: ["a", "z"] }],
    ["白名单清空", { tool_allow: [] }],
    ["改 url", { url: "https://other.example.com/mcp" }],
    ["改密钥值", { headers: { Authorization: "new" } }],
    ["改 transport", { transport: "stdio", command: "npx" }],
  ];
  for (const [label, input] of expanding) {
    it(`放大（${label}）→ 待批`, async () => {
      const r = await hub.as("libu.shangshu").updateMcpServer("shrink", input);
      expect(r.status).toBe("pending_approval");
    });
  }

  it("放大申请批准 → 生效；期间被改 → 执行失败并告知申请人", async () => {
    const off = hub.as("libu.shangshu");
    const r1 = await off.updateMcpServer("shrink", { enabled: true, reason: "恢复使用" });
    if (r1.status !== "pending_approval") throw new Error("应待批");
    await hub.emperor.resolveNotification(r1.notification_id, { option: "approve" });
    expect(hub.ctx.mcp.getServer("shrink").enabled).toBe(true);

    const r2 = await off.updateMcpServer("shrink", { targets: [{ kind: "all" }], reason: "扩大" });
    if (r2.status !== "pending_approval") throw new Error("应待批");
    applied(await hub.emperor.updateMcpServer("shrink", { description: "陛下改了说明" }));
    const vBefore = hub.ctx.mcp.getServer("shrink").version;
    await hub.emperor.resolveNotification(r2.notification_id, { option: "approve" });
    const cur = hub.ctx.mcp.getServer("shrink");
    expect(cur.version).toBe(vBefore);
    expect(cur.targets).toEqual([{ kind: "dept", id: "bingbu" }]);
    const a = (await hub.emperor.approvals()).find((x) => x.id === r2.approval_id)!;
    expect(String(a.payload.apply_error)).toMatch(/审批期间已被修改/);
    await waitFor(() => !hub.ctx.db.get("SELECT 1 FROM meta WHERE k = ?", `mcp_pending:${r2.approval_id}`));
  });

  it("改地址却沿用已存密钥：待办正文提醒陛下；url 中的凭据不显示", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("handover")));
    const r = await hub.as("libu.shangshu").updateMcpServer("handover", { url: "https://bob:pw-in-url@evil.example.com/mcp", headers: { Authorization: null } });
    if (r.status !== "pending_approval") throw new Error("应待批");
    const n = await hub.emperor.notification(r.notification_id);
    expect(n.body).toMatch(/沿用已存密钥（请求头 Authorization）/);
    expect(n.body).not.toContain(SECRET);
    expect(n.body).not.toContain("pw-in-url");
    expect(n.body).toContain("evil.example.com");
  });

  it("修改事件只列字段名，不放字段值", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("evq")));
    applied(await hub.emperor.updateMcpServer("evq", { url: "https://mcp.example.com/mcp?api_key=url-token-xyz" }));
    const ev = hub.ctx.db.all<{ summary: string; data_json: string }>("SELECT summary, data_json FROM events WHERE type = 'mcp.updated' AND subject_id = 'evq'");
    expect(ev.length).toBe(1);
    expect(ev[0].summary).toContain("改动：url");
    expect(ev[0].summary + ev[0].data_json).not.toContain("url-token-xyz");
  });

  it("官员删除直接生效", async () => {
    applied(await hub.emperor.createMcpServer(httpInput("todel")));
    expect(await hub.as("libu.shangshu").deleteMcpServer("todel", { reason: "下线" })).toEqual({ status: "deleted", id: "todel" });
  });

  it("官员不能测草稿；可测已存配置（有 mcp_test_server）", async () => {
    const off = hub.as("libu.shangshu");
    await expectStatus(off.testMcpDraft({ server: httpInput("draft1") }), 403);
    const res = await off.testMcpServer("shrink");
    expect(res.ok).toBe(true);
  });
});

describe("broker 与部门通知", () => {
  it("变更后 broker reload，然后向各部门发 /control/mcp", async () => {
    broker.got.length = 0;
    dept.got.length = 0;
    applied(await hub.emperor.createMcpServer(httpInput("notify1")));
    await waitFor(() => dept.got.some((r) => r.path === "/control/mcp"));
    const reload = broker.got.find((r) => r.path === "/admin/reload");
    expect(reload?.auth).toBe(`Bearer ${hub.ctx.mcpToken}`);
    expect(dept.got.find((r) => r.path === "/control/mcp")?.auth).toBe(`Bearer ${hub.ctx.controlToken}`);
  });

  it("broker 不可达：仍通知部门，记 mcp.broker_unreachable 事件（节流）", async () => {
    hub.ctx.mcpUrl = "http://127.0.0.1:9";
    try {
      dept.got.length = 0;
      applied(await hub.emperor.createMcpServer(httpInput("notify2")));
      await waitFor(() => dept.got.some((r) => r.path === "/control/mcp"));
      await waitFor(() => !!hub.ctx.db.get("SELECT 1 FROM events WHERE type = 'mcp.broker_unreachable'"));
      dept.got.length = 0;
      applied(await hub.emperor.updateMcpServer("notify2", { name: "再改" }));
      await waitFor(() => dept.got.some((r) => r.path === "/control/mcp"));
      expect(hub.ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM events WHERE type = 'mcp.broker_unreachable'")?.n).toBe(1);
      await expectStatus(hub.emperor.mcpStatus(), 503);
    } finally {
      hub.ctx.mcpUrl = broker.url;
    }
  });

  it("status / test / restart / 草稿测试 转 broker", async () => {
    expect(await hub.emperor.mcpStatus()).toEqual([{ id: "x", version: 1, state: "ready", tool_count: 2 }]);
    broker.got.length = 0;
    const t = await hub.emperor.testMcpServer("dup");
    expect(t.ok).toBe(true);
    const sent = broker.got.find((r) => r.path === "/admin/test")!.body as { config: McpServerConfig };
    expect(sent.config.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect((await hub.emperor.restartMcpServer("dup")).state).toBe("connecting");
    await expectStatus(hub.emperor.restartMcpServer("nope"), 404);
    // 草稿：base_id 沿用已存密钥，不保存
    broker.got.length = 0;
    const before = hub.ctx.mcp.version();
    await hub.emperor.testMcpDraft({ base_id: "dup", server: { url: "https://draft.example.com/mcp", headers: { Authorization: null } } });
    const draft = (broker.got.find((r) => r.path === "/admin/test")!.body as { config: McpServerConfig }).config;
    expect(draft).toMatchObject({ id: "dup", url: "https://draft.example.com/mcp", headers: { Authorization: `Bearer ${SECRET}` } });
    expect(hub.ctx.mcp.version()).toBe(before);
    expect(hub.ctx.mcp.getServer("dup").url).toBe("https://mcp.example.com/mcp");
    // 草稿校验
    await expectStatus(hub.emperor.testMcpDraft({ server: { name: "n", transport: "stdio", targets: [] } }), 400);
  });

  it("broker 拒绝令牌 → 503 并提示核对 MCP_TOKEN", async () => {
    const tok = hub.ctx.mcpToken;
    hub.ctx.mcpToken = "mc_wrong";
    try {
      const e = await expectStatus(hub.emperor.mcpStatus(), 503);
      expect(e.message).toContain("MCP_TOKEN");
    } finally {
      hub.ctx.mcpToken = tok;
    }
  });
});

describe("内部状态鉴权", () => {
  it("broker token 可取全量（含密钥、部门 token、职位）", async () => {
    const c = new HubClient({ baseUrl: hub.url, token: hub.ctx.mcpToken });
    const st = await c.mcpInternalState();
    expect(st.version).toBe(hub.ctx.mcp.version());
    expect(st.servers.find((s) => s.id === "dup")?.headers).toEqual({ Authorization: `Bearer ${SECRET}` });
    expect(st.tokens[hub.ctx.registry.deptToken("bingbu")!]).toBe("bingbu");
    expect(st.posts["bingbu.shangshu"]).toEqual({ dept: "bingbu", official_id: hub.ctx.registry.officialOf("bingbu.shangshu")!.official_id });
  });

  it("部门 token、网关、皇帝端口无 token → 403", async () => {
    await expectStatus(hub.as("libu.shangshu").mcpInternalState(), 403);
    await expectStatus(hub.gateway.mcpInternalState(), 403);
    await expectStatus(hub.emperor.mcpInternalState(), 403);
    const r = await raw(hub, "GET", "/api/internal/mcp/state", { token: hub.ctx.registry.deptToken("libu")! });
    expect(r.status).toBe(403);
  });

  it("control token（部门可读）不能取密钥、不能改 MCP 配置", async () => {
    const tok = hub.ctx.controlToken;
    expect((await raw(hub, "GET", "/api/internal/mcp/state", { token: tok })).status).toBe(403);
    expect((await raw(hub, "GET", "/api/mcp/servers", { token: tok })).status).toBe(403);
    expect((await raw(hub, "POST", "/api/mcp/servers", { token: tok, body: httpInput("sys-sneak") })).status).toBe(403);
  });

  it("broker token 不能访问其他接口", async () => {
    const tok = hub.ctx.mcpToken;
    for (const [m, p] of [
      ["GET", "/api/registry"],
      ["GET", "/api/mcp/servers"],
      ["GET", "/api/messages?limit=1"],
      ["GET", "/api/approvals"],
      ["GET", "/api/internal/tokens"],
      ["POST", "/api/messages"],
    ] as const) {
      const r = await raw(hub, m, p, { token: tok, body: m === "POST" ? {} : undefined });
      expect(r.status, `${m} ${p}`).toBe(403);
    }
    // 皇帝端口带 broker token 同样受限
    expect((await raw(hub, "GET", "/api/registry", { token: tok, port: "emperor" })).status).toBe(403);
    expect((await raw(hub, "GET", "/api/internal/mcp/state", { token: tok, port: "emperor" })).status).toBe(200);
  });
});

describe("授权解析", () => {
  it("all / dept / official", async () => {
    const off = hub.ctx.registry.officialOf("hubu.shangshu")!;
    applied(await hub.emperor.createMcpServer(httpInput("acc-all", { targets: [{ kind: "all" }] })));
    applied(await hub.emperor.createMcpServer(httpInput("acc-dept", { targets: [{ kind: "dept", id: "bingbu" }] })));
    applied(await hub.emperor.createMcpServer(httpInput("acc-off", { targets: [{ kind: "official", id: off.official_id }] })));
    applied(await hub.emperor.createMcpServer(httpInput("acc-dis", { enabled: false, targets: [{ kind: "all" }] })));

    const a1 = await hub.emperor.mcpAccess("bingbu.zhifang_langzhong");
    const ids1 = a1.servers.map((s) => s.id);
    expect(ids1).toContain("acc-all");
    expect(ids1).toContain("acc-dept");
    expect(ids1).not.toContain("acc-off");
    expect(ids1).not.toContain("acc-dis");
    expect(a1.servers.find((s) => s.id === "acc-dept")!.via).toEqual([{ kind: "dept", id: "bingbu" }]);

    const a2 = await hub.emperor.mcpAccess("hubu.shangshu");
    expect(a2.official_id).toBe(off.official_id);
    expect(a2.servers.map((s) => s.id)).toContain("acc-off");
    expect(a2.servers.map((s) => s.id)).not.toContain("acc-dept");
  });

  it("官员可查自己；查他人须 mcp_get_access；不存在的职位 404", async () => {
    const me = hub.as("bingbu.zhifang_langzhong");
    expect((await me.mcpAccess("bingbu.zhifang_langzhong")).post_id).toBe("bingbu.zhifang_langzhong");
    await expectStatus(me.mcpAccess("hubu.shangshu"), 403);
    expect((await hub.as("libu.shangshu").mcpAccess("hubu.shangshu")).post_id).toBe("hubu.shangshu");
    await expectStatus(hub.emperor.mcpAccess("no.such"), 404);
    await expectStatus(hub.emperor.mcpAccess(""), 400);
  });
});

describe("旧库升级", () => {
  it("重启时职位定义按 config/court.yaml 同步（旧库也能拿到 mcp_admin），MCP 配置与 broker token 保留", async () => {
    const { mkdtempSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "court-hub-mcp-"));
    try {
      const h1 = await startHub({ dataDir: dir });
      applied(await h1.emperor.createMcpServer(httpInput("keep", { targets: [] })));
      const tok = h1.ctx.mcpToken;
      // 模拟旧库：职位定义里没有 mcp_admin
      const row = h1.ctx.db.get<{ def_json: string }>("SELECT def_json FROM posts WHERE post_id = 'libu.shangshu'")!;
      const def = JSON.parse(row.def_json) as { tool_groups: string[] };
      def.tool_groups = def.tool_groups.filter((g) => g !== "mcp_admin");
      h1.ctx.db.run("UPDATE posts SET def_json = ? WHERE post_id = 'libu.shangshu'", JSON.stringify(def));
      await h1.dispose();
      const h2 = await startHub({ dataDir: dir });
      try {
        expect(h2.ctx.registry.hasTool("libu.shangshu", "mcp_create_server")).toBe(true);
        expect(h2.ctx.mcpToken).toBe(tok);
        expect(h2.ctx.mcp.getServer("keep").headers).toEqual({ Authorization: `Bearer ${SECRET}` });
      } finally {
        await h2.dispose();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("longFetch（broker 长请求）", () => {
  it("返回状态与正文；按 AbortSignal 限时中止", async () => {
    const { longFetch } = await import("../src/services/long-fetch.ts");
    const slow = createServer((req, res) => {
      if (req.url === "/hang") return; // 不应答
      res.writeHead(418, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "teapot", code: "internal" }));
    });
    await new Promise<void>((ok) => slow.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
    try {
      const r = await longFetch(`${base}/x`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
      expect(r.status).toBe(418);
      expect(await r.json()).toEqual({ error: "teapot", code: "internal" });
      const t0 = Date.now();
      await expect(longFetch(`${base}/hang`, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
      expect(Date.now() - t0).toBeLessThan(2000);
    } finally {
      slow.closeAllConnections();
      await new Promise<void>((ok) => slow.close(() => ok()));
    }
  });
});
