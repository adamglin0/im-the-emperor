#!/usr/bin/env node
// 根据 config/court.yaml 生成 docker-compose.yml。用法：node scripts/gen-compose.mjs [输出路径]
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, stringify } from "yaml";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(process.argv[2] ?? join(root, "docker-compose.yml"));
const court = parse(readFileSync(join(root, "config", "court.yaml"), "utf8"));

/** 需要沙箱（armory 网络）的部门 */
const ARMORY_DEPTS = new Set(["bingbu", "gongbu", "xingbu"]);
const HUB_URL = "http://hub:8000";
const GATEWAY_URL = "http://gateway:8100";
const SANDBOX_URL = "http://sandbox:8200";
const MCP_URL = "http://mcp:8300";
const APP_IMAGE = "court-app:latest";
const SANDBOX_IMAGE = "court-sandbox:latest";
const MCP_IMAGE = "court-mcp:latest";
const MCP_TOKEN = "${MCP_TOKEN:?请先运行 scripts/court.sh init 补充 .env}";

const deptHosts = (court.depts ?? []).map((d) => ({
  id: String(d.id),
  host: d.host ?? `dept-${String(d.id).replace(/_/g, "-")}`,
  service: `dept-${String(d.id).replace(/_/g, "-")}`,
}));
/**
 * MCP 中转站禁止经 HTTP 传输访问的主机：朝廷内部服务（含各部门的服务名与主机名）、本机，
 * 以及 Docker Desktop 的宿主别名（宿主 127.0.0.1:8001 是无 token 的皇帝端口）。
 */
const MCP_BLOCKED_HOSTS = [...new Set(["hub", "gateway", "sandbox", "mcp", "localhost", "127.0.0.1", "::1", "0.0.0.0", "host.docker.internal", "gateway.docker.internal", ...deptHosts.flatMap((d) => [d.host, d.service])])].join(",");

const healthcheck = (url) => ({
  test: ["CMD", "node", "-e", `fetch('${url}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`],
  interval: "10s",
  timeout: "5s",
  retries: 6,
  start_period: "20s",
});

const app = (extra) => ({
  image: APP_IMAGE,
  build: { context: ".", dockerfile: "Dockerfile" },
  restart: "unless-stopped",
  init: true,
  stop_grace_period: "40s",
  ...extra,
});

const hubHealthy = { hub: { condition: "service_healthy" } };

const services = {
  hub: app({
    hostname: "hub",
    environment: {
      ROLE: "hub",
      PORT: "8000",
      DATA_DIR: "/data",
      CONFIG_DIR: "/config",
      WEB_DIR: "/app/web",
      // 内部 API（需 token）：8000；皇帝/Web（无 token = 皇帝）：8001，仅发布到本机
      EMPEROR_PORT: "8001",
      HUB_DB_PATH: "/data/hub-db/court.db",
      GATEWAY_URL,
      LLM_MODE: "${LLM_MODE:-real}",
      // hub 优先采用这些 env token，并写入 /data/shared/tokens.json 供部门读取
      GATEWAY_TOKEN: "${GATEWAY_TOKEN:?请先运行 scripts/court.sh init 生成 .env}",
      GATEWAY_ADMIN_TOKEN: "${GATEWAY_ADMIN_TOKEN:?请先运行 scripts/court.sh init 补充 .env}",
      CONTROL_TOKEN: "${CONTROL_TOKEN:?请先运行 scripts/court.sh init 生成 .env}",
      SANDBOX_TOKEN: "${SANDBOX_TOKEN:?请先运行 scripts/court.sh init 生成 .env}",
      // hub ↔ MCP 中转站共用密钥（只给 hub 与 mcp，不写入部门可读的 shared/tokens.json）
      MCP_TOKEN,
      MCP_URL,
    },
    ports: ["127.0.0.1:8001:8001"],
    // 档案库（SQLite WAL）放在独立卷：macOS 上绑定卷的 mmap/锁语义不可靠（init 在 macOS 设 HUB_DB_STORE=hub-db 命名卷）
    volumes: ["./data/hub:/data/hub", "${HUB_DB_STORE:-./data/hub-db}:/data/hub-db", "./data/shared:/data/shared", "./config:/config:ro"],
    networks: ["court"],
    healthcheck: healthcheck("http://127.0.0.1:8001/api/health"),
  }),
  gateway: app({
    hostname: "gateway",
    environment: {
      ROLE: "gateway",
      PORT: "8100",
      DATA_DIR: "/data",
      CONFIG_DIR: "/config",
      HUB_URL,
      LLM_MODE: "${LLM_MODE:-real}",
      GATEWAY_TOKEN: "${GATEWAY_TOKEN:?请先运行 scripts/court.sh init 生成 .env}",
      GATEWAY_ADMIN_TOKEN: "${GATEWAY_ADMIN_TOKEN:?请先运行 scripts/court.sh init 补充 .env}",
      OPENCODE_API_KEY: "${OPENCODE_API_KEY:-}",
      GATEWAY_MAX_CONCURRENCY: "${GATEWAY_MAX_CONCURRENCY:-6}",
      // 出网代理：在 .env.providers 里设 HTTPS_PROXY 即生效；皇城内部服务不走代理
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: "hub,gateway,sandbox,localhost,127.0.0.1",
    },
    // 可选：各提供商密钥的环境变量（ANTHROPIC_API_KEY=… 等），与设置页存的凭据并存（设置页优先）
    env_file: [{ path: ".env.providers", required: false }],
    volumes: [
      "./data/gateway:/data/gateway",
      "./data/shared:/data/shared:ro",
      "./config:/config:ro",
      // pi 的 auth.json（opencode-go 密钥）。没有该文件时在 .env 里设 PI_AUTH_FILE=/dev/null 并改用 OPENCODE_API_KEY
      "${PI_AUTH_FILE:-${HOME}/.pi/agent/auth.json}:/secrets/pi-auth.json:ro",
    ],
    networks: ["court"],
    depends_on: hubHealthy,
    healthcheck: healthcheck("http://127.0.0.1:8100/health"),
  }),
  sandbox: {
    image: SANDBOX_IMAGE,
    build: { context: ".", dockerfile: "docker/sandbox.Dockerfile", args: { DEBIAN_MIRROR: "${DEBIAN_MIRROR:-}" } },
    hostname: "sandbox",
    restart: "unless-stopped",
    init: true,
    stop_grace_period: "40s",
    environment: {
      PORT: "8200",
      SANDBOX_ROOT: "/workspaces",
      SANDBOX_TOKEN: "${SANDBOX_TOKEN:?请先运行 scripts/court.sh init 生成 .env}",
    },
    // 默认绑定 ./data/sandbox；macOS（OrbStack/Docker Desktop）绑定卷不支持 chown，工作区 uid 隔离失效，
    // 此时 init 会设 SANDBOX_WORKSPACES=sandbox-workspaces（命名卷，真实 Linux 文件系统）
    volumes: ["${SANDBOX_WORKSPACES:-./data/sandbox}:/workspaces"],
    networks: ["armory"],
    read_only: true,
    tmpfs: ["/tmp:size=256m,mode=1777"],
    cap_drop: ["ALL"],
    cap_add: ["CHOWN", "DAC_OVERRIDE", "FOWNER", "SETUID", "SETGID", "KILL"],
    security_opt: ["no-new-privileges:true"],
    mem_limit: "1g",
    cpus: 1.0,
    pids_limit: 256,
    healthcheck: healthcheck("http://127.0.0.1:8200/health"),
  },
  // MCP 中转站：为每个 stdio MCP 服务器经宿主 docker 起独立容器（默认 bridge 网络，不入朝廷网络）。
  // 挂 docker.sock 等同宿主 root：中转站只运行皇帝批准过的配置。
  mcp: {
    image: MCP_IMAGE,
    build: { context: ".", dockerfile: "docker/mcp.Dockerfile" },
    hostname: "mcp",
    restart: "unless-stopped",
    init: true,
    stop_grace_period: "40s",
    environment: {
      PORT: "8300",
      HUB_URL,
      MCP_TOKEN,
      MCP_STDIO_RUNNER: "docker",
      MCP_BLOCKED_HOSTS,
    },
    volumes: ["/var/run/docker.sock:/var/run/docker.sock"],
    networks: ["court"],
    depends_on: hubHealthy,
    healthcheck: healthcheck("http://127.0.0.1:8300/health"),
  },
};

for (const d of court.depts ?? []) {
  const { id, host, service: name } = deptHosts.find((x) => x.id === String(d.id));
  const armory = ARMORY_DEPTS.has(id);
  services[name] = app({
    hostname: host,
    environment: {
      ROLE: "dept",
      DEPT: id,
      PORT: String(d.port ?? 8080),
      DATA_DIR: "/data",
      CONFIG_DIR: "/config",
      HUB_URL,
      GATEWAY_URL,
      MCP_URL,
      ...(armory ? { SANDBOX_URL } : {}),
    },
    // 部门只挂：官员数据（会话/记忆/日志）、本部门 outbox/cursor、共享 token（只读）
    volumes: ["./data/officials:/data/officials", `./data/depts/${id}:/data/depts/${id}`, "./data/shared:/data/shared:ro", "./config:/config:ro"],
    networks: armory ? { court: { aliases: [host] }, armory: { aliases: [host] } } : { court: { aliases: [host] } },
    depends_on: hubHealthy,
    healthcheck: healthcheck(`http://127.0.0.1:${d.port ?? 8080}/health`),
  });
}

const doc = {
  name: "im-the-emperor",
  services,
  volumes: { "sandbox-workspaces": {}, "hub-db": {} },
  networks: {
    court: { name: "court" },
    // 沙箱所在网络：兵/工/刑部可达沙箱；沙箱不在 court 网络，触不到 hub/网关
    armory: { name: "armory" },
  },
};

const header = [
  "# 由 scripts/gen-compose.mjs 根据 config/court.yaml 生成，请勿手改（改名册后重新生成）。",
  "# 先运行 scripts/court.sh init 生成 .env（随机 token）；mock 演练：scripts/court.sh mock-up",
  "",
].join("\n");
writeFileSync(out, header + stringify(doc, { lineWidth: 0 }));
console.log(`[gen-compose] 已生成 ${out}（${Object.keys(services).length} 个服务）`);
