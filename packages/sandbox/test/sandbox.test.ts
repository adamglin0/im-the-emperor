import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, SandboxClient } from "@court/shared";
import { isBlockedAddress } from "../src/fetch.ts";
import { startSandbox, type SandboxHandle } from "../src/server.ts";

const TOKEN = "sb_test_token_123456";
let root: string;
let sb: SandboxHandle;
let client: SandboxClient;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "sandbox-test-"));
  sb = await startSandbox({ port: 0, hostname: "127.0.0.1", root, token: TOKEN });
  client = new SandboxClient({ baseUrl: sb.url, token: TOKEN, timeoutMs: 30_000 });
});

afterAll(async () => {
  await sb?.close();
  rmSync(root, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectApiError(p: Promise<unknown>, status: number): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ApiError);
    expect((e as ApiError).status).toBe(status);
    return e as ApiError;
  }
  throw new Error(`应当失败（${status}）`);
}

describe("鉴权", () => {
  it("缺 token → 401；/health 免鉴权", async () => {
    const anon = new SandboxClient({ baseUrl: sb.url });
    await expectApiError(anon.exec({ workspace: "bingbu", command: "true" }), 401);
    expect((await fetch(`${sb.url}/health`)).status).toBe(200);
  });
});

describe("/exec", () => {
  it("在工作区内运行 bash -lc，HOME=工作区，环境已清洗", async () => {
    process.env.SUPER_SECRET_FOR_TEST = "leak-me";
    const r = await client.exec({ workspace: "bingbu", command: 'echo "$HOME|$PWD|${SUPER_SECRET_FOR_TEST:-none}"; echo err >&2; exit 3' });
    delete process.env.SUPER_SECRET_FOR_TEST;
    expect(r.state).toBe("done");
    expect(r.exit_code).toBe(3);
    const [home, pwd, secret] = r.stdout.trim().split("|");
    expect(home.endsWith("/bingbu")).toBe(true);
    expect(pwd).toBe(home);
    expect(secret).toBe("none");
    expect(r.stderr.trim()).toBe("err");
  });

  it("cwd 子目录；越界 cwd 被拒", async () => {
    mkdirSync(join(root, "gongbu", "src"), { recursive: true });
    const r = await client.exec({ workspace: "gongbu", command: "basename $PWD", cwd: "src" });
    expect(r.stdout.trim()).toBe("src");
    await expectApiError(client.exec({ workspace: "gongbu", command: "pwd", cwd: "../bingbu" }), 403);
    await expectApiError(client.exec({ workspace: "Bad-Name", command: "pwd" }), 400);
  });

  it("超时杀掉整个进程组（含后台子进程）", async () => {
    const t0 = Date.now();
    const r = await client.exec({ workspace: "xingbu", command: "sleep 30 & echo $! > child.pid; sleep 30", timeout_seconds: 1 });
    expect(r.state).toBe("timeout");
    expect(Date.now() - t0).toBeLessThan(8000);
    const childPid = Number(readFileSync(join(root, "xingbu", "child.pid"), "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(childPid)).toBe(false);
  });

  it("主进程退出后残留的后台进程也被清理，不会挂住请求", async () => {
    const t0 = Date.now();
    const r = await client.exec({ workspace: "xingbu", command: "sleep 30 & echo $! > bg.pid; echo hi", timeout_seconds: 20 });
    expect(r.state).toBe("done");
    expect(r.stdout.trim()).toBe("hi");
    expect(Date.now() - t0).toBeLessThan(5000);
    const bgPid = Number(readFileSync(join(root, "xingbu", "bg.pid"), "utf8"));
    await new Promise((res) => setTimeout(res, 300));
    expect(alive(bgPid)).toBe(false);
  });

  it("后台作业：查询状态、取消", async () => {
    const started = await client.exec({ workspace: "bingbu", command: "echo started; sleep 30", background: true });
    expect(started.state).toBe("running");
    await new Promise((res) => setTimeout(res, 300));
    const mid = await client.job(started.job_id);
    expect(mid.state).toBe("running");
    expect(mid.stdout).toContain("started");
    const cancelled = await client.cancel(started.job_id);
    expect(cancelled.state).toBe("killed");
    await expectApiError(client.job("job_nope"), 404);
  });

  it("同时运行作业数有上限", async () => {
    const jobs = [];
    for (let i = 0; i < 16; i++) jobs.push(await client.exec({ workspace: "bingbu", command: "sleep 30", background: true }));
    await expectApiError(client.exec({ workspace: "bingbu", command: "true" }), 429);
    for (const j of jobs) await client.cancel(j.job_id);
  });

  it("输出超过 64KB 截断", async () => {
    const r = await client.exec({ workspace: "bingbu", command: "head -c 200000 /dev/zero | tr '\\0' 'a'" });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBe(64 * 1024);
  });
});

describe("/fs", () => {
  it("写读列", async () => {
    await client.writeFile({ workspace: "gongbu", path: "docs/a.md", content: "# 营造法式" });
    const read = await client.readFile("gongbu", "docs/a.md");
    expect(read).toMatchObject({ content: "# 营造法式", encoding: "utf8" });
    const list = await client.list("gongbu", "docs");
    expect(list).toEqual([{ name: "a.md", type: "file", size: Buffer.byteLength("# 营造法式") }]);
    await client.writeFile({ workspace: "gongbu", path: "bin.dat", content: Buffer.from([0, 1, 2, 255]).toString("base64"), encoding: "base64" });
    expect((await client.readFile("gongbu", "bin.dat")).encoding).toBe("base64");
  });

  it("路径穿越被拒（相对、绝对、符号链接）", async () => {
    writeFileSync(join(root, "secret.txt"), "top secret");
    await expectApiError(client.readFile("gongbu", "../secret.txt"), 403);
    await expectApiError(client.readFile("gongbu", "/etc/passwd"), 403);
    await expectApiError(client.writeFile({ workspace: "gongbu", path: "../../evil.txt", content: "x" }), 403);
    await expectApiError(client.list("gongbu", "../.."), 403);
    symlinkSync(root, join(root, "gongbu", "escape"));
    await expectApiError(client.readFile("gongbu", "escape/secret.txt"), 403);
    await expectApiError(client.writeFile({ workspace: "gongbu", path: "escape/new.txt", content: "x" }), 403);
    expect(existsSync(join(root, "new.txt"))).toBe(false);
    // 悬空符号链接（指向工作区外不存在的文件）也不能被写穿
    symlinkSync(join(root, "dangling-target.txt"), join(root, "gongbu", "dangling"));
    await expectApiError(client.writeFile({ workspace: "gongbu", path: "dangling", content: "x" }), 403);
    expect(existsSync(join(root, "dangling-target.txt"))).toBe(false);
    // 指向工作区内的链接：解析为真实路径后读取（仍在工作区内，允许）
    symlinkSync(join(root, "gongbu", "docs", "a.md"), join(root, "gongbu", "inner-link"));
    expect((await client.readFile("gongbu", "inner-link")).content).toBe("# 营造法式");
  });

  it("未用过的工作区：列根目录为空，读文件 404", async () => {
    expect(await client.list("libu_rites")).toEqual([]);
    await expectApiError(client.readFile("libu_rites", "x.txt"), 404);
    expect(existsSync(join(root, "libu_rites"))).toBe(false);
  });

  it("超过 2MB 拒绝", async () => {
    await expectApiError(client.writeFile({ workspace: "gongbu", path: "big.txt", content: "a".repeat(2 * 1024 * 1024 + 1) }), 413);
  });
});

describe("/fetch", () => {
  it("回环/私网/链路本地/元数据地址被拦截", async () => {
    for (const url of ["http://[::127.0.0.1]/", "http://127.0.0.1:1/", "http://localhost:8000/api/health", "http://169.254.169.254/latest/meta-data", "http://10.0.0.1/", "http://[::1]/", "http://192.168.1.1/"]) {
      await expectApiError(client.fetchUrl({ url }), 403);
    }
  });

  it("只允许 http/https", async () => {
    await expectApiError(client.fetchUrl({ url: "file:///etc/passwd" }), 400);
    await expectApiError(client.fetchUrl({ url: "ftp://example.com/" }), 400);
  });

  it("地址判定", () => {
    expect(isBlockedAddress("127.0.0.1")).toBe(true);
    expect(isBlockedAddress("172.20.0.5")).toBe(true);
    expect(isBlockedAddress("::ffff:10.1.2.3")).toBe(true);
    expect(isBlockedAddress("fe80::1")).toBe(true);
    expect(isBlockedAddress("fd12:3456::1")).toBe(true);
    expect(isBlockedAddress("::7f00:1")).toBe(true);
    expect(isBlockedAddress("2002:7f00:1::")).toBe(true);
    expect(isBlockedAddress("8.8.8.8")).toBe(false);
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
  });
});
