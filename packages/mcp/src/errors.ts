// broker 统一错误：HTTP 状态 + ErrorCode + 中文可操作信息。
import type { ErrorCode, McpServerConfig } from "@court/shared";

export type BrokerStatus = 400 | 401 | 403 | 404 | 409 | 413 | 500 | 502 | 503 | 504;

export class BrokerError extends Error {
  constructor(
    public status: BrokerStatus,
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "BrokerError";
  }
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** 从错误文本中抹掉该配置的密钥值与 URL 查询串（防止经错误信息泄露给官员/日志）。 */
export function redactSecrets(text: string, config: Pick<McpServerConfig, "env" | "headers" | "url">): string {
  let out = text;
  const secrets = [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})].filter((v) => typeof v === "string" && v.length >= 4);
  // 先替换长的，避免短值是长值子串时残留
  for (const s of secrets.sort((a, b) => b.length - a.length)) out = out.split(s).join("***");
  if (config.url) {
    const q = config.url.indexOf("?");
    if (q >= 0 && q < config.url.length - 1) out = out.split(config.url.slice(q + 1)).join("***");
  }
  return out;
}
