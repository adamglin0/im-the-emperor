// 按配置建 MCP 传输：streamable HTTP（拦截朝廷内部主机）、stdio（docker 容器或本地进程）。
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@court/shared";
import { buildDockerRunArgs, createContainerName, forceRemoveContainer } from "./docker.ts";
import { BrokerError } from "./errors.ts";

export type StdioRunner = "docker" | "local";

export interface TransportOptions {
  runner: StdioRunner;
  dockerBin: string;
  /** 小写主机名集合 */
  blockedHosts: ReadonlySet<string>;
  /** 容器归属标签值（见 CONTAINER_OWNER_LABEL） */
  containerOwner: string;
  purpose: "serve" | "test";
}

export interface OpenedTransport {
  transport: Transport;
  /** docker 容器名（仅 stdio + docker） */
  containerName?: string;
  /** 子进程 stderr 末尾（最多 4KB），用于错误信息 */
  readStderrTail(): string;
  /** 关闭连接前调用（HTTP：终止服务端会话） */
  beforeClose(): Promise<void>;
  /** 关闭连接后的兜底清理（docker rm -f） */
  afterClose(): Promise<void>;
}

const STDERR_TAIL_BYTES = 4096;
const TERMINATE_SESSION_TIMEOUT_MS = 2_000;

export function openTransport(config: McpServerConfig, opts: TransportOptions): OpenedTransport {
  if (config.transport === "streamable_http") return openHttpTransport(config, opts.blockedHosts);
  if (config.transport === "stdio") return openStdioTransport(config, opts);
  throw new BrokerError(400, "bad_request", `不支持的 MCP 传输方式：${String(config.transport)}`);
}

/** 校验 HTTP 地址：http/https，且主机名不在禁止列表。返回解析后的 URL。 */
export function assertHttpUrlAllowed(rawUrl: string | undefined, blockedHosts: ReadonlySet<string>): URL {
  let url: URL;
  try {
    url = new URL(rawUrl ?? "");
  } catch {
    throw new BrokerError(400, "bad_request", "MCP 服务器地址 url 不是合法 URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new BrokerError(400, "bad_request", "MCP 服务器地址只支持 http:// 或 https://");
  const host = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (blockedHosts.has(host)) throw new BrokerError(403, "forbidden", `地址主机 ${host} 属于朝廷内部服务，禁止经 MCP 中转站访问`);
  return url;
}

function openHttpTransport(config: McpServerConfig, blockedHosts: ReadonlySet<string>): OpenedTransport {
  const url = assertHttpUrlAllowed(config.url, blockedHosts);
  // 不跟随重定向：防止经 30x 绕过主机拦截
  const transport = new StreamableHTTPClientTransport(url, { requestInit: { headers: { ...(config.headers ?? {}) }, redirect: "error" } });
  return {
    transport,
    readStderrTail: () => "",
    beforeClose: async () => {
      if (!transport.sessionId) return;
      await Promise.race([transport.terminateSession().catch(() => undefined), new Promise((r) => setTimeout(r, TERMINATE_SESSION_TIMEOUT_MS).unref())]);
    },
    afterClose: async () => undefined,
  };
}

function openStdioTransport(config: McpServerConfig, opts: TransportOptions): OpenedTransport {
  const secretEnv = { ...(config.env ?? {}) };
  let command: string;
  let args: string[];
  let containerName: string | undefined;
  if (opts.runner === "docker") {
    containerName = createContainerName(config.id, opts.purpose);
    command = opts.dockerBin;
    args = buildDockerRunArgs(config, containerName, opts.containerOwner);
  } else {
    if (!config.command) throw new BrokerError(400, "bad_request", `MCP 服务器 ${config.id} 缺少启动命令 command`);
    command = config.command;
    args = [...(config.args ?? [])];
  }
  const env = { ...getDefaultEnvironment(), ...dockerClientEnv(opts.runner), ...secretEnv };
  const transport = new StdioClientTransport({ command, args, env, stderr: "pipe" });
  let tail = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => {
    tail = (tail + chunk.toString()).slice(-STDERR_TAIL_BYTES);
  });
  return {
    transport,
    containerName,
    readStderrTail: () => tail.trim(),
    beforeClose: async () => undefined,
    afterClose: async () => {
      if (containerName) await forceRemoveContainer(opts.dockerBin, containerName);
    },
  };
}

/** docker CLI 需要的宿主环境（getDefaultEnvironment 只保留 PATH/HOME 等少数变量） */
function dockerClientEnv(runner: StdioRunner): Record<string, string> {
  if (runner !== "docker") return {};
  const out: Record<string, string> = {};
  for (const key of ["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]) {
    const v = process.env[key];
    if (v) out[key] = v;
  }
  return out;
}
