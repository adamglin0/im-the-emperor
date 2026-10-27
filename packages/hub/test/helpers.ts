// 测试辅助：临时数据目录 + createHub（随机端口、不启动后台循环）+ 可控时钟。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ApiError, HubClient } from "@court/shared";
import { createHub, type HubHandle } from "../src/main.ts";

export const CONFIG_DIR = fileURLToPath(new URL("../../../config", import.meta.url));

export interface TestHub extends HubHandle {
  dataDir: string;
  clock: { t: number };
  /** 皇帝客户端（无 token） */
  emperor: HubClient;
  /** 某部门某职位的客户端 */
  as(post: string): HubClient;
  gateway: HubClient;
  dispose(): Promise<void>;
}

// 门铃/控制面默认打到本机一个不存在的端口，立即失败
const DEAD = "http://127.0.0.1:9";
const ALL_DEPTS = ["zhengshitang", "zhongshu", "menxia", "shangshu", "libu", "hubu", "libu_rites", "bingbu", "xingbu", "gongbu", "yushitai"];

export function deadDeptOverrides(extra: Record<string, string> = {}): string {
  const o: Record<string, string> = {};
  for (const d of ALL_DEPTS) o[d] = DEAD;
  return JSON.stringify({ ...o, ...extra });
}

export async function startHub(opts: { dataDir?: string; t?: number } = {}): Promise<TestHub> {
  if (!process.env.DEPT_URL_OVERRIDES) process.env.DEPT_URL_OVERRIDES = deadDeptOverrides();
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "court-hub-"));
  const clock = { t: opts.t ?? Date.now() };
  const hub = await createHub({ dataDir, configDir: CONFIG_DIR, port: 0, emperorPort: 0, hostname: "127.0.0.1", startLoops: false, webDir: join(dataDir, "no-web"), gatewayUrl: "http://127.0.0.1:9", now: () => clock.t });
  const as = (post: string) => {
    const dept = hub.ctx.registry.post(post)?.dept;
    if (!dept) throw new Error(`no post ${post}`);
    return new HubClient({ baseUrl: hub.url, token: hub.ctx.registry.deptToken(dept), actingPost: post });
  };
  return {
    ...hub,
    dataDir,
    clock,
    emperor: new HubClient({ baseUrl: hub.emperorUrl }),
    gateway: new HubClient({ baseUrl: hub.url, token: hub.tokens.gateway }),
    as,
    async dispose() {
      await hub.close();
      if (!opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 断言 promise 以指定 HTTP 状态失败，返回错误 */
export async function expectStatus(p: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ApiError) {
      if (e.status !== status) throw new Error(`期望 ${status}，实际 ${e.status}：${e.message}`);
      return e;
    }
    throw e;
  }
  throw new Error(`期望失败 ${status}，实际成功`);
}

/** 原始请求：默认带 token 走内部端口、不带 token 走皇帝端口；port 可显式指定 */
export async function raw(
  hub: TestHub,
  method: string,
  path: string,
  opts: { token?: string; post?: string; body?: unknown; headers?: Record<string, string>; port?: "internal" | "emperor" } = {},
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", ...(opts.headers ?? {}) };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.post) headers["x-acting-post"] = opts.post;
  const base = (opts.port ?? (opts.token ? "internal" : "emperor")) === "internal" ? hub.url : hub.emperorUrl;
  return fetch(base + path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
}
