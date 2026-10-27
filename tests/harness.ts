// 进程内起整座朝廷：hub + 网关(mock) + 沙箱 + 11 部门。端到端测试与本地演示共用。
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { HubClient, sleepMs, type DeptId } from "@court/shared";
import { createHub, type HubHandle } from "../packages/hub/src/main.ts";
import { startGateway, type GatewayHandle } from "../packages/gateway/src/server.ts";
import { startSandbox, type SandboxHandle } from "../packages/sandbox/src/server.ts";
import { startDept, type DeptHandle } from "../packages/dept/src/main.ts";

export const DEPTS: DeptId[] = ["zhengshitang", "zhongshu", "menxia", "shangshu", "libu", "hubu", "libu_rites", "bingbu", "xingbu", "gongbu", "yushitai"];
const WORKSHOP_DEPTS = new Set(["bingbu", "gongbu", "xingbu"]);

export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
    s.on("error", rej);
  });
}

export interface Court {
  dataDir: string;
  hub: HubHandle;
  gateway: GatewayHandle;
  sandbox: SandboxHandle;
  depts: Map<string, DeptHandle>;
  deptPorts: Record<string, number>;
  /** 皇帝客户端（emperor 端口，无 token） */
  emperor: HubClient;
  /** 以某部门身份代某职位调用 hub 内部端口 */
  as(post: string): HubClient;
  restartDept(dept: string): Promise<void>;
  close(): Promise<void>;
}

export interface CourtOptions {
  dataDir?: string;
  keepData?: boolean;
  /** 加速时序（测试用） */
  fast?: boolean;
  mode?: "mock" | "real";
  /** 皇帝/Web 端口（默认随机；本地演示固定 8001） */
  emperorPort?: number;
  /** 托管的 Web 构建目录（默认 hub 的 packages/web/dist） */
  webDir?: string;
}

/** 网关管理接口 token：只给 hub，与部门可见的网关 token 不同 */
const ADMIN_TOKEN = "gwa_harness_admin_token_0001";

export async function startCourt(opts: CourtOptions = {}): Promise<Court> {
  const dataDir = opts.dataDir ?? mkdtempSync(join(tmpdir(), "court-e2e-"));
  const configDir = resolve(import.meta.dirname, "..", "config");
  const deptPorts: Record<string, number> = {};
  for (const d of DEPTS) deptPorts[d] = await freePort();
  const gatewayPort = await freePort();
  const overrides = Object.fromEntries(DEPTS.map((d) => [d, `http://127.0.0.1:${deptPorts[d]}`]));
  process.env.DEPT_URL_OVERRIDES = JSON.stringify(overrides);

  const hub = await createHub({ dataDir, configDir, port: 0, emperorPort: opts.emperorPort ?? 0, hostname: "127.0.0.1", gatewayUrl: `http://127.0.0.1:${gatewayPort}`, gatewayAdminToken: ADMIN_TOKEN, startLoops: true, webDir: opts.webDir });
  const tokensFile = JSON.parse(readFileSync(join(dataDir, "shared", "tokens.json"), "utf8")) as { depts: Record<string, string>; gateway: string; control: string; sandbox: string };
  const sandbox = await startSandbox({ port: 0, hostname: "127.0.0.1", root: join(dataDir, "sandbox"), token: tokensFile.sandbox });
  const gateway = await startGateway({ port: gatewayPort, hostname: "127.0.0.1", hubUrl: hub.url, dataDir, configDir, mode: opts.mode ?? "mock", tokens: { gateway: tokensFile.gateway, depts: tokensFile.depts, admin: ADMIN_TOKEN } });

  const limits = opts.fast ? { minTurnGapMs: 200, wakeDebounceMs: 150, heartbeatMs: 1000, inboxPollMs: 3000 } : undefined;
  const depts = new Map<string, DeptHandle>();
  const launch = async (d: string) => {
    const h = await startDept({
      dept: d,
      hubUrl: hub.url,
      gatewayUrl: gateway.url,
      sandboxUrl: WORKSHOP_DEPTS.has(d) ? sandbox.url : undefined,
      dataDir,
      port: deptPorts[d],
      hostname: "127.0.0.1",
      deptUrlOverrides: overrides,
      limits,
    });
    depts.set(d, h);
  };
  await Promise.all(DEPTS.map(launch));

  const emperor = new HubClient({ baseUrl: hub.emperorUrl, timeoutMs: 30_000 });
  return {
    dataDir,
    hub,
    gateway,
    sandbox,
    depts,
    deptPorts,
    emperor,
    as(post: string) {
      const dept = post.split(".")[0];
      return new HubClient({ baseUrl: hub.url, token: tokensFile.depts[dept], actingPost: post, timeoutMs: 30_000 });
    },
    async restartDept(d: string) {
      await depts.get(d)?.close();
      await launch(d);
    },
    async close() {
      await Promise.allSettled([...depts.values()].map((h) => h.close()));
      await gateway.close();
      await sandbox.close();
      await hub.close();
      if (!opts.keepData && !opts.dataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** 轮询直到条件成立 */
export async function until<T>(what: string, fn: () => Promise<T | undefined | false>, timeoutMs = 120_000, everyMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v as T;
    } catch (e) {
      last = e;
    }
    await sleepMs(everyMs);
  }
  throw new Error(`等待超时：${what}${last ? `（最后错误：${(last as Error).message}）` : ""}`);
}
