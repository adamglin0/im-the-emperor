// broker 日志：stdout 一行 JSON。调用方负责不放入密钥（env/headers 值、token）。
export type LogLevel = "info" | "warn" | "error";

export function logEvent(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, role: "mcp", event, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
