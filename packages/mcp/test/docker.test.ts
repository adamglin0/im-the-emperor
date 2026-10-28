// docker 运行参数（纯函数，总是运行）+ 真实容器测试（MCP_DOCKER_TEST=1 才运行）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpAdminClient, McpClient, type McpServerConfig } from "@court/shared";
import { buildDockerRunArgs, createContainerName } from "../src/docker.ts";
import { redactSecrets } from "../src/errors.ts";
import { startMcp, type McpHandle } from "../src/server.ts";
import { startFakeHub, type FakeHub } from "./fake-hub.ts";

const base: McpServerConfig = {
  id: "fs_tool",
  name: "文件",
  description: "",
  transport: "stdio",
  enabled: true,
  targets: [{ kind: "all" }],
  command: "npx",
  args: ["-y", "@scope/server", "--flag"],
  env: { API_KEY: "super-secret-value", OTHER: "x" },
  version: 7,
  created_at: 1,
  updated_at: 1,
  updated_by: "emperor",
};

describe("docker 运行参数", () => {
  it("按规范生成参数；密钥只给键名", () => {
    const args = buildDockerRunArgs(base, "court-mcp-fs_tool-abc123");
    expect(args).toEqual([
      "run", "-i", "--rm",
      "--name", "court-mcp-fs_tool-abc123",
      "--label", "court.mcp=fs_tool",
      "--label", "court.mcp.version=7",
      "--label", "court.mcp.owner=court",
      "--network", "bridge",
      "--memory", "512m",
      "--cpus", "1",
      "--pids-limit", "256",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--tmpfs", "/tmp:rw,exec,nosuid,size=512m",
      "--tmpfs", "/root:rw,nosuid,size=256m",
      "--tmpfs", "/home:rw,nosuid,size=64m",
      "-e", "HOME=/tmp",
      "-e", "npm_config_cache=/tmp/.npm",
      "-e", "UV_CACHE_DIR=/tmp/.uv",
      "-e", "API_KEY",
      "-e", "OTHER",
      "node:24-slim", "npx", "-y", "@scope/server", "--flag",
    ]);
    expect(args.join(" ")).not.toContain("super-secret-value");
  });

  it("自定义镜像、断网、资源；越界值钳到上限", () => {
    const args = buildDockerRunArgs({ ...base, image: "ghcr.io/x/y:1", network: "none", memory_mb: 99999, cpus: 2.5, env: {} }, "n");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args[args.indexOf("--memory") + 1]).toBe("4096m");
    expect(args[args.indexOf("--cpus") + 1]).toBe("2.5");
    expect(args.slice(-5)).toEqual(["ghcr.io/x/y:1", "npx", "-y", "@scope/server", "--flag"]);
  });

  it("保留环境变量名被拒绝；缺 command 被拒绝", () => {
    expect(() => buildDockerRunArgs({ ...base, env: { PATH: "/x" } }, "n")).toThrow(/保留名/);
    expect(() => buildDockerRunArgs({ ...base, env: { DOCKER_HOST: "tcp://evil" } }, "n")).toThrow(/保留名/);
    expect(() => buildDockerRunArgs({ ...base, command: undefined }, "n")).toThrow(/command/);
  });

  it("以 - 开头的镜像名被拒绝（否则会被 docker 当成 --privileged 等参数）；command 以 - 开头只是容器参数", () => {
    for (const image of ["--privileged", "-v=/:/host", "--volume=/var/run/docker.sock:/s", " node"]) {
      expect(() => buildDockerRunArgs({ ...base, image }, "n")).toThrow(/镜像名/);
    }
    const args = buildDockerRunArgs({ ...base, image: "node:24-slim", command: "--privileged" }, "n");
    expect(args.slice(-5, -3)).toEqual(["node:24-slim", "--privileged"]);
  });

  it("内存取整；归属标签可指定", () => {
    const args = buildDockerRunArgs({ ...base, memory_mb: 100.6 }, "n", "test-xyz");
    expect(args[args.indexOf("--memory") + 1]).toBe("101m");
    expect(args).toContain("court.mcp.owner=test-xyz");
  });

  it("容器名：测试容器带 -test-", () => {
    expect(createContainerName("fs_tool", "serve")).toMatch(/^court-mcp-fs_tool-[0-9a-f]{6}$/);
    expect(createContainerName("fs_tool", "test")).toMatch(/^court-mcp-fs_tool-test-[0-9a-f]{6}$/);
  });

  it("错误信息抹掉密钥与 URL 查询串", () => {
    const text = redactSecrets("failed super-secret-value at https://x.io/mcp?key=abcd1234", { env: base.env, url: "https://x.io/mcp?key=abcd1234" });
    expect(text).toBe("failed *** at https://x.io/mcp?***");
  });
});

const dockerEnabled = process.env.MCP_DOCKER_TEST === "1";

describe.skipIf(!dockerEnabled)("真实 docker 运行（MCP_DOCKER_TEST=1）", () => {
  const BROKER_TOKEN = "mc_docker_test_token_0001";
  const DEPT_TOKEN = "dk_docker_test_0001";
  const SECRET = "docker-secret-value-42";
  let hub: FakeHub;
  let broker: McpHandle;
  const script = readFileSync(resolve(import.meta.dirname, "fixtures", "raw-stdio-server.cjs"), "utf8");
  const config: McpServerConfig = { ...base, id: "dockfix", command: "node", args: ["-e", script], env: { FIXTURE_SECRET: SECRET }, network: "none", memory_mb: 256 };

  beforeAll(async () => {
    hub = await startFakeHub(BROKER_TOKEN, { version: 1, servers: [config], tokens: { [DEPT_TOKEN]: "libu" }, posts: { "libu.shangshu": { dept: "libu" } } });
    broker = await startMcp({ port: 0, hostname: "127.0.0.1", hubUrl: hub.url, token: BROKER_TOKEN, runner: "docker", pollMs: 60_000, containerOwner: `test-${process.pid}` });
    await new McpAdminClient({ baseUrl: broker.url, token: BROKER_TOKEN }).reload();
  }, 60_000);
  afterAll(async () => {
    await broker?.close();
    await hub?.close();
  });

  const listContainers = () => execFileSync("docker", ["ps", "-aq", "--filter", "label=court.mcp=dockfix"], { encoding: "utf8" }).trim();

  it("容器内运行、密钥经环境传入、关闭后容器被清理", async () => {
    const c = new McpClient({ baseUrl: broker.url, token: DEPT_TOKEN, actingPost: "libu.shangshu", timeoutMs: 300_000 });
    const res = await c.call({ server: "dockfix", tool: "whoami", arguments: {} });
    expect(res.content[0]).toMatchObject({ type: "text", text: `secret=${SECRET};home=/tmp` });
    const status = (await new McpAdminClient({ baseUrl: broker.url, token: BROKER_TOKEN }).status())[0];
    expect(status.container).toMatch(/^court-mcp-dockfix-[0-9a-f]{6}$/);
    expect(listContainers()).not.toBe("");
    // 命令行不含密钥
    const inspect = execFileSync("docker", ["inspect", "--format", "{{json .Args}}", status.container!], { encoding: "utf8" });
    expect(inspect).not.toContain(SECRET);
    await broker.close();
    for (let i = 0; i < 50 && listContainers(); i++) await new Promise((r) => setTimeout(r, 200));
    expect(listContainers()).toBe("");
  }, 300_000);
});
