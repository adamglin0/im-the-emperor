#!/usr/bin/env node
// 初始化部署：生成 .env（缺失的随机 token 才补，已有的不动）、创建数据目录、生成 docker-compose.yml。
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envFile = join(root, ".env");
const token = (prefix) => `${prefix}_${randomBytes(24).toString("base64url")}`;

const existing = new Map();
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line);
    if (m) existing.set(m[1], m[2]);
  }
}

const piAuth = join(homedir(), ".pi", "agent", "auth.json");
const defaults = [
  ["GATEWAY_TOKEN", () => token("gw"), "网关 token（hub 调网关、网关调 hub）"],
  ["CONTROL_TOKEN", () => token("ctl"), "hub → 部门控制面 token"],
  ["GATEWAY_ADMIN_TOKEN", () => token("gwa"), "hub → 网关管理接口（模型提供商与凭据）token；只给 hub 与网关，不下发部门"],
  ["SANDBOX_TOKEN", () => token("sb"), "部门 → 沙箱 token"],
  ["MCP_TOKEN", () => token("mc"), "hub ↔ MCP 中转站 token；只给 hub 与 mcp，不下发部门"],
  ["LLM_MODE", () => "real", "real | mock（mock = 零成本脚本化假模型）"],
  ["PI_AUTH_FILE", () => (existsSync(piAuth) ? piAuth : "/dev/null"), "pi 的 auth.json（含 opencode-go 密钥）；没有就用 /dev/null 并设置 OPENCODE_API_KEY"],
  ["OPENCODE_API_KEY", () => "", "可选：直接给 opencode-go 密钥（优先于 auth.json）"],
  ["GATEWAY_MAX_CONCURRENCY", () => "6", "网关每提供商并发上限"],
  [
    "SANDBOX_WORKSPACES",
    () => (process.platform === "darwin" ? "sandbox-workspaces" : "./data/sandbox"),
    "沙箱工作区：./data/sandbox（绑定目录，Linux 推荐）或 sandbox-workspaces（命名卷；macOS 绑定卷无法 chown，须用命名卷才能按工作区隔离）",
  ],
  [
    "HUB_DB_STORE",
    () => (process.platform === "darwin" ? "hub-db" : "./data/hub-db"),
    "皇城档案库（SQLite WAL）所在：./data/hub-db（绑定目录，Linux）或 hub-db（命名卷；macOS 推荐，绑定卷上 WAL 的 mmap/锁不可靠）",
  ],
  ["DEBIAN_MIRROR", () => "", "可选：沙箱镜像构建用的 Debian 镜像源（官方源慢时如 mirrors.aliyun.com）"],
];

const added = [];
let text = existsSync(envFile) ? readFileSync(envFile, "utf8") : "# 朝廷部署环境（scripts/init.mjs 生成；含密钥，勿提交）\n";
if (text && !text.endsWith("\n")) text += "\n";
for (const [key, gen, comment] of defaults) {
  if (existing.has(key)) continue;
  text += `# ${comment}\n${key}=${gen()}\n`;
  added.push(key);
}
writeFileSync(envFile, text);
chmodSync(envFile, 0o600);
console.log(added.length ? `[init] .env 已补充：${added.join(", ")}` : "[init] .env 已完整，未改动");

// 各容器只挂自己需要的子目录（见 gen-compose.mjs）；预先建好，避免 docker 以 root 身份创建
const DEPT_IDS = ["zhengshitang", "zhongshu", "menxia", "shangshu", "libu", "hubu", "libu_rites", "bingbu", "xingbu", "gongbu", "yushitai"];
const dirs = ["data/hub", "data/shared", "data/gateway", "data/officials", "data/sandbox", ...DEPT_IDS.map((d) => `data/depts/${d}`)];
for (const d of dirs) mkdirSync(join(root, d), { recursive: true });
console.log("[init] 数据目录就绪：data/{hub,hub-db,shared,gateway,officials,sandbox,depts/*}");
if (process.platform === "linux") {
  console.log("[init] 提示（Linux）：沙箱服务以 root（受限 capabilities）运行、作业以每工作区独立 uid 运行；其余服务以 uid 1000 运行，必要时：sudo chown -R 1000 data/hub data/shared data/gateway data/officials data/depts");
}

const r = spawnSync(process.execPath, [join(root, "scripts", "gen-compose.mjs")], { stdio: "inherit" });
process.exit(r.status ?? 0);
