// 设置页的模型提供商管理：内置提供商登录（api-key 交互流程）、清除凭据、自定义 OpenAI 兼容提供商、持久化、鉴权。
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, GatewayClient, type ProviderLoginSession } from "@court/shared";
import { FileCredentialStore } from "../src/credentials.ts";
import { startGateway, type GatewayHandle } from "../src/server.ts";
import { startFakeHub, type FakeHub } from "./fake-hub.ts";

const GATEWAY_TOKEN = "gw_test_token_providers_01";
const DEPT_TOKENS = { menxia: "tok_menxia_providers" };
const CONFIG_DIR = join(import.meta.dirname, "../../../config");
const DEEPSEEK_KEY = "sk-deepseek-test-0123456789abcd";
const CUSTOM_KEY = "sk-custom-test-9876543210wxyz";

let hub: FakeHub;
let gw: GatewayHandle;
let dataDir: string;
let admin: GatewayClient;
let upstream: Server;
let upstreamUrl: string;
const seen: { headers: IncomingHttpHeaders; body: Record<string, unknown> }[] = [];
const savedEnv = { DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY };

/** 极简 OpenAI 兼容上游：/v1/chat/completions 流式回「可」 */
function startUpstream(): Promise<Server> {
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      seen.push({ headers: req.headers, body: raw ? JSON.parse(raw) : {} });
      if (!req.url?.endsWith("/chat/completions")) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (o: unknown) => res.write(`data: ${JSON.stringify(o)}\n\n`);
      const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: "m" };
      chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "可" }, finish_reason: null }] });
      chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 1, total_tokens: 8 } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r(srv)));
}

async function startGw(): Promise<GatewayHandle> {
  return startGateway({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, dataDir, configDir: CONFIG_DIR, mode: "real", tokens: { gateway: GATEWAY_TOKEN, depts: DEPT_TOKENS } });
}

async function pollUntil(sid: string, pred: (s: ProviderLoginSession) => boolean): Promise<ProviderLoginSession> {
  for (let i = 0; i < 100; i++) {
    const s = await admin.adminLogin(sid);
    if (pred(s)) return s;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("登录会话未达预期状态");
}

beforeAll(async () => {
  delete process.env.DEEPSEEK_API_KEY;
  dataDir = mkdtempSync(join(tmpdir(), "gw-prov-"));
  hub = await startFakeHub({ gatewayToken: GATEWAY_TOKEN, deptTokens: DEPT_TOKENS });
  hub.setBudget(() => ({ allowed: true }));
  upstream = await startUpstream();
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
  gw = await startGw();
  admin = new GatewayClient({ baseUrl: gw.url, token: GATEWAY_TOKEN, timeoutMs: 10_000 });
});

afterAll(async () => {
  await gw?.close();
  await hub?.close();
  upstream?.close();
  rmSync(dataDir, { recursive: true, force: true });
  if (savedEnv.DEEPSEEK_API_KEY !== undefined) process.env.DEEPSEEK_API_KEY = savedEnv.DEEPSEEK_API_KEY;
});

describe("网关提供商管理", () => {
  it("管理接口只认网关 token", async () => {
    const dept = new GatewayClient({ baseUrl: gw.url, token: DEPT_TOKENS.menxia, timeoutMs: 5000 });
    await expect(dept.adminProviders()).rejects.toMatchObject({ status: 403 });
  });

  it("列出 pi 内置提供商：登录方式、环境变量、是否可用目录外模型", async () => {
    const list = await admin.adminProviders();
    const ids = list.map((p) => p.id);
    for (const id of ["anthropic", "openai", "google", "deepseek", "openrouter", "opencode-go", "groq", "xai", "mistral"]) expect(ids).toContain(id);
    const anthropic = list.find((p) => p.id === "anthropic")!;
    expect(anthropic.login_methods).toEqual(["api_key", "oauth"]);
    expect(list.find((p) => p.id === "openai")!.env_vars).toContain("OPENAI_API_KEY");
    const ds = list.find((p) => p.id === "deepseek")!;
    expect(ds).toMatchObject({ kind: "builtin", configured: false, allow_unlisted: true });
    expect(ds.model_count).toBeGreaterThan(0);
    expect(list.find((p) => p.id === "openrouter")!.allow_unlisted).toBe(false); // 多接口：无从推断
    expect(list.find((p) => p.id === "custom")?.kind ?? "legacy").toBe("legacy");
  });

  it("未配置凭据时调用 → AUTH_ERROR，提示去设置页", async () => {
    const res = await admin.complete({
      model_key: "deepseek/deepseek-chat",
      context: { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] } as never,
      metadata: { post_id: "system.test", purpose: "other" },
      skip_budget: true,
    });
    expect(res.message.stopReason).toBe("error");
    expect(res.message.errorMessage).toMatch(/AUTH_ERROR.*设置/);
  });

  it("api-key 登录流程：提示→作答→落盘 0600，接口只回密钥提示", async () => {
    const start = await admin.adminStartLogin("deepseek", "api_key");
    expect(start.provider).toBe("deepseek");
    const waiting = await pollUntil(start.id, (s) => s.state === "awaiting_input");
    expect(waiting.prompt?.type).toBe("secret");
    await expect(admin.adminAnswerLogin(start.id, waiting.prompt!.seq + 1, "x")).rejects.toMatchObject({ status: 409 });
    await admin.adminAnswerLogin(start.id, waiting.prompt!.seq, DEEPSEEK_KEY);
    const done = await pollUntil(start.id, (s) => s.state !== "running" && s.state !== "awaiting_input");
    expect(done.state).toBe("done");

    const file = join(dataDir, "gateway", "credentials.json");
    expect(JSON.parse(readFileSync(file, "utf8")).deepseek).toMatchObject({ type: "api_key", key: DEEPSEEK_KEY });
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);

    const list = await admin.adminProviders();
    const ds = list.find((p) => p.id === "deepseek")!;
    expect(ds).toMatchObject({ configured: true, source: "stored credential", credential: { type: "api_key", key_hint: "…abcd" } });
    expect(JSON.stringify(list)).not.toContain(DEEPSEEK_KEY);

    // 目录外模型：单接口提供商可推断
    const chk = await admin.adminCheckModel("deepseek", "deepseek-future-x");
    expect(chk).toMatchObject({ ok: true, listed: false, configured: true });
  });

  it("取消登录；清除凭据后回到未配置", async () => {
    const s = await admin.adminStartLogin("groq", "api_key");
    await pollUntil(s.id, (x) => x.state === "awaiting_input");
    expect((await admin.adminCancelLogin(s.id)).state).toBe("cancelled");
    await expect(admin.adminAnswerLogin(s.id, 1, "k")).rejects.toMatchObject({ status: 409 });

    const after = await admin.adminLogout("deepseek");
    expect(after.configured).toBe(false);
    expect(after.credential).toBeUndefined();
  });

  it("不支持的登录方式与未知提供商", async () => {
    await expect(admin.adminStartLogin("deepseek", "oauth")).rejects.toMatchObject({ status: 400 });
    await expect(admin.adminStartLogin("custom", "api_key")).rejects.toMatchObject({ status: 400 });
    await expect(admin.adminStartLogin("nope", "api_key")).rejects.toMatchObject({ status: 404 });
    const chk = await admin.adminCheckModel("nope", "x");
    expect(chk.ok).toBe(false);
  });

  it("自定义提供商：校验", async () => {
    const bad = (spec: object) => admin.adminSaveProvider(spec as never).catch((e: ApiError) => e);
    expect(await bad({ id: "openai", api: "openai-completions", base_url: upstreamUrl })).toMatchObject({ status: 400 });
    expect(await bad({ id: "my-llm", api: "nope", base_url: upstreamUrl })).toMatchObject({ status: 400 });
    expect(await bad({ id: "my-llm", api: "openai-completions", base_url: "ftp://x" })).toMatchObject({ status: 400 });
    expect(await bad({ id: "Bad Id", api: "openai-completions", base_url: upstreamUrl })).toMatchObject({ status: 400 });
    expect(await bad({ id: "custom", api: "openai-completions", base_url: upstreamUrl })).toMatchObject({ status: 400 });
  });

  it("自定义 OpenAI 兼容提供商：保存、连通测试走上游且带密钥与请求头", async () => {
    const info = await admin.adminSaveProvider({
      id: "local-llm",
      name: "本地模型",
      api: "openai-completions",
      base_url: upstreamUrl,
      api_key: CUSTOM_KEY,
      headers: { "X-Org": "court" },
      models: [{ id: "qwen-local", context_window: 32_000 }],
    });
    expect(info).toMatchObject({ id: "local-llm", kind: "custom", configured: true, model_count: 1, header_names: ["X-Org"], allow_unlisted: true });
    expect(JSON.stringify(info)).not.toContain(CUSTOM_KEY);
    expect((await admin.adminProviderModels("local-llm"))[0]).toMatchObject({ id: "qwen-local", context_window: 32_000 });

    seen.length = 0;
    const t = await admin.adminTestProvider("local-llm");
    expect(t).toMatchObject({ ok: true, model: "local-llm/qwen-local", text: "可" });
    expect(seen[0].headers.authorization).toBe(`Bearer ${CUSTOM_KEY}`);
    expect(seen[0].headers["x-org"]).toBe("court");
    expect(seen[0].body.model).toBe("qwen-local");

    // 目录外模型 ID 也可用
    const t2 = await admin.adminTestProvider("local-llm", "another-model");
    expect(t2.ok).toBe(true);
    expect(seen.at(-1)!.body.model).toBe("another-model");

    // 再存一次不带 headers/api_key：保留原值
    await admin.adminSaveProvider({ id: "local-llm", api: "openai-completions", base_url: upstreamUrl, models: [{ id: "qwen-local" }] });
    seen.length = 0;
    expect((await admin.adminTestProvider("local-llm")).ok).toBe(true);
    expect(seen[0].headers.authorization).toBe(`Bearer ${CUSTOM_KEY}`);
    expect(seen[0].headers["x-org"]).toBe("court");

    // 换上游地址：旧密钥/请求头不随之发往新地址，须重新填写
    const moved = upstreamUrl.replace("127.0.0.1", "localhost");
    const err = (spec: object) => admin.adminSaveProvider(spec as never).catch((e: ApiError) => e);
    expect(await err({ id: "local-llm", api: "openai-completions", base_url: moved, api_key: "sk-new-key-000000000000" })).toMatchObject({ status: 400, message: expect.stringMatching(/请求头/) });
    expect(await err({ id: "local-llm", api: "openai-completions", base_url: moved, headers: { "X-Org": "court" } })).toMatchObject({ status: 400, message: expect.stringMatching(/API 密钥/) });
    expect((await admin.adminProviders()).find((p) => p.id === "local-llm")?.base_url).toBe(upstreamUrl);
  });

  it("无鉴权自定义提供商（keyless）", async () => {
    const info = await admin.adminSaveProvider({ id: "ollama", api: "openai-completions", base_url: upstreamUrl, keyless: true });
    expect(info).toMatchObject({ configured: true, keyless: true, source: "无需密钥" });
    expect((await admin.adminTestProvider("ollama", "llama3")).ok).toBe(true);
    await admin.adminDeleteProvider("ollama");
    await expect(admin.adminProviderModels("ollama")).rejects.toMatchObject({ status: 404 });
    await expect(admin.adminDeleteProvider("openai")).rejects.toMatchObject({ status: 400 });
  });

  it("重启网关：自定义提供商与凭据仍在", async () => {
    await gw.close();
    gw = await startGw();
    admin = new GatewayClient({ baseUrl: gw.url, token: GATEWAY_TOKEN, timeoutMs: 10_000 });
    const p = (await admin.adminProviders()).find((x) => x.id === "local-llm");
    expect(p).toMatchObject({ kind: "custom", configured: true, credential: { key_hint: "…wxyz" } });
    expect((await admin.adminTestProvider("local-llm")).ok).toBe(true);
    expect(statSync(join(dataDir, "gateway", "providers.json")).mode & 0o777).toBe(0o600);
  });
});

describe("凭据库文件", () => {
  it("文件损坏：报错不带文件内容，拒绝写入且不执行修改函数", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gw-cred-"));
    try {
      const file = join(dir, "credentials.json");
      writeFileSync(file, 'x{"deepseek":{"type":"api_key","key":"sk-leak-0123456789abcdef"}}');
      const store = new FileCredentialStore(file);
      expect(store.loadError).toBeTruthy();
      expect(store.loadError).not.toContain("sk-");
      let called = false;
      await expect(
        store.modify("deepseek", async () => {
          called = true;
          return { type: "api_key", key: "k" };
        }),
      ).rejects.toThrow(/拒绝写入/);
      expect(called).toBe(false);
      expect(await store.read("deepseek")).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
