// stdio 服务器的 docker 运行参数与容器清理。密钥只经 docker CLI 进程环境传入（`-e KEY` 不带值）。
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { MCP_DEFAULT_IMAGE, MCP_LIMITS, type McpServerConfig } from "@court/shared";
import { BrokerError } from "./errors.ts";

export const CONTAINER_LABEL = "court.mcp";
/** 容器归属标签：启动清理只删同一归属的遗留容器（测试/开发的中转站不会误删正式部署的容器） */
export const CONTAINER_OWNER_LABEL = `${CONTAINER_LABEL}.owner`;
export const DEFAULT_CONTAINER_OWNER = "court";

/**
 * 镜像名：必须以字母数字开头。`docker run [OPTIONS] IMAGE` 中以 "-" 开头的「镜像」会被当成 docker 参数
 * （如 --privileged、-v=/:/host），等同容器逃逸。hub 已校验，这里兜底（/admin/test 的草稿也走这里）。
 */
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,254}$/;

/** 容器内固定环境：--read-only 下把 HOME 与各包管理器缓存指向 tmpfs */
const FIXED_CONTAINER_ENV = ["HOME=/tmp", "npm_config_cache=/tmp/.npm", "UV_CACHE_DIR=/tmp/.uv"];

/**
 * 不能作为密钥变量名的键：它们经 docker CLI 进程环境传入，会改变 CLI 自身行为（找不到可执行文件、连错 daemon），
 * 或与上面的固定容器环境冲突。
 */
const RESERVED_ENV_KEYS = new Set(["PATH", "HOME", "npm_config_cache", "UV_CACHE_DIR"]);

export function getReservedEnvKeyOrNull(env: Record<string, string> | undefined): string | null {
  for (const key of Object.keys(env ?? {})) {
    if (RESERVED_ENV_KEYS.has(key) || key.toUpperCase().startsWith("DOCKER_")) return key;
  }
  return null;
}

export function createContainerName(serverId: string, purpose: "serve" | "test"): string {
  const rand = randomBytes(3).toString("hex");
  return purpose === "test" ? `court-mcp-${serverId}-test-${rand}` : `court-mcp-${serverId}-${rand}`;
}

/** `docker run -i --rm …` 的完整参数（不含 docker 可执行文件本身）。 */
export function buildDockerRunArgs(config: McpServerConfig, containerName: string, owner = DEFAULT_CONTAINER_OWNER): string[] {
  if (!config.command) throw new BrokerError(400, "bad_request", `MCP 服务器 ${config.id} 缺少启动命令 command`);
  const image = config.image || MCP_DEFAULT_IMAGE;
  if (!IMAGE_RE.test(image)) throw new BrokerError(400, "bad_request", `镜像名 ${JSON.stringify(image.slice(0, 200))} 不合法（须以字母或数字开头，如 ${MCP_DEFAULT_IMAGE}）`);
  const reserved = getReservedEnvKeyOrNull(config.env);
  if (reserved) throw new BrokerError(400, "bad_request", `环境变量名 ${reserved} 为保留名（会影响 docker 客户端或容器基础环境），请改用其他名字`);
  const memoryMb = Math.round(clampNumber(config.memory_mb, MCP_LIMITS.defaultMemoryMb, 16, MCP_LIMITS.maxMemoryMb));
  const cpus = clampNumber(config.cpus, MCP_LIMITS.defaultCpus, 0.1, MCP_LIMITS.maxCpus);
  const args = [
    "run",
    "-i",
    "--rm",
    "--name",
    containerName,
    "--label",
    `${CONTAINER_LABEL}=${config.id}`,
    "--label",
    `${CONTAINER_LABEL}.version=${config.version}`,
    "--label",
    `${CONTAINER_OWNER_LABEL}=${owner}`,
    "--network",
    config.network === "none" ? "none" : "bridge",
    "--memory",
    `${memoryMb}m`,
    "--cpus",
    String(cpus),
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    // npx/uvx 把包下载到 /tmp 下的缓存并从那里执行：docker tmpfs 默认 noexec，须显式 exec
    "/tmp:rw,exec,nosuid,size=512m",
    "--tmpfs",
    "/root:rw,nosuid,size=256m",
    "--tmpfs",
    "/home:rw,nosuid,size=64m",
  ];
  for (const kv of FIXED_CONTAINER_ENV) args.push("-e", kv);
  for (const key of Object.keys(config.env ?? {}).sort()) args.push("-e", key);
  // 镜像之后的 command/args 原样交给容器（docker 在第一个位置参数处停止解析自身参数）
  args.push(image, config.command, ...(config.args ?? []));
  return args;
}

function clampNumber(v: number | undefined, fallback: number, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, v));
}

export function runDocker(dockerBin: string, args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(dockerBin, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${dockerBin} ${args[0]} 失败：${(stderr || err.message).trim().slice(-500)}`));
      else resolve(stdout);
    });
  });
}

/** 强删容器（关闭时兜底）；容器已随 --rm 消失时忽略错误。 */
export async function forceRemoveContainer(dockerBin: string, name: string): Promise<void> {
  await runDocker(dockerBin, ["rm", "-f", name], 15_000).catch(() => undefined);
}

/** 启动时清理本归属上次遗留的 MCP 容器，返回清理数量。 */
export async function removeStaleContainers(dockerBin: string, owner = DEFAULT_CONTAINER_OWNER): Promise<number> {
  const out = await runDocker(dockerBin, ["ps", "-aq", "--filter", `label=${CONTAINER_LABEL}`, "--filter", `label=${CONTAINER_OWNER_LABEL}=${owner}`]);
  const ids = out.split(/\s+/).filter(Boolean);
  if (ids.length) await runDocker(dockerBin, ["rm", "-f", ...ids], 60_000);
  return ids.length;
}
