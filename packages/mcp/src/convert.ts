// MCP SDK 结果 ↔ 朝廷契约类型的转换（纯函数）。
import { createHash } from "node:crypto";
import type { McpContent, McpToolInfo } from "@court/shared";

/** 单张图片上限（base64 解码后）；超出改为 other 摘要 */
export const MAX_IMAGE_BYTES = 1024 * 1024;
/** 单段文本上限：防止异常服务器回传超大文本拖垮部门（部门侧另有 8KB 截断） */
export const MAX_TEXT_CHARS = 512 * 1024;
const MAX_DESCRIPTION_CHARS = 4096;

interface SdkTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { title?: string };
}

export function toMcpToolInfo(t: SdkTool): McpToolInfo {
  const title = t.title ?? t.annotations?.title;
  return {
    name: t.name,
    ...(title ? { title } : {}),
    description: (t.description ?? "").slice(0, MAX_DESCRIPTION_CHARS),
    input_schema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} },
  };
}

/** 按白名单过滤（空/缺省 = 全部），再截到上限 */
export function filterAllowedTools(tools: McpToolInfo[], toolAllow: string[] | undefined, limit: number): McpToolInfo[] {
  const allow = toolAllow?.length ? new Set(toolAllow) : null;
  return tools.filter((t) => !allow || allow.has(t.name)).slice(0, limit);
}

export function isToolAllowed(tool: string, toolAllow: string[] | undefined): boolean {
  return !toolAllow?.length || toolAllow.includes(tool);
}

export function hashTools(tools: McpToolInfo[]): string {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex").slice(0, 12);
}

/** MCP CallToolResult.content 中的单项 → McpContent */
export function toMcpContent(item: unknown): McpContent {
  const c = (item ?? {}) as Record<string, unknown>;
  switch (c.type) {
    case "text":
      return { type: "text", text: truncateText(String(c.text ?? "")) };
    case "image": {
      const data = String(c.data ?? "");
      const mimeType = String(c.mimeType ?? "application/octet-stream");
      const bytes = base64DecodedBytes(data);
      if (bytes > MAX_IMAGE_BYTES) return { type: "other", summary: `图片（${mimeType}，约 ${formatBytes(bytes)}）超过 1MB，已省略` };
      return { type: "image", data, mimeType };
    }
    case "audio":
      return { type: "other", summary: `音频（${String(c.mimeType ?? "未知类型")}，约 ${formatBytes(base64DecodedBytes(String(c.data ?? "")))}），已省略` };
    case "resource": {
      const r = (c.resource ?? {}) as Record<string, unknown>;
      const uri = String(r.uri ?? "");
      const mimeType = typeof r.mimeType === "string" ? r.mimeType : undefined;
      if (typeof r.text === "string") return { type: "resource", uri, text: truncateText(r.text), ...(mimeType ? { mimeType } : {}) };
      if (typeof r.blob === "string") return { type: "other", summary: `二进制资源 ${uri}（${mimeType ?? "未知类型"}，约 ${formatBytes(base64DecodedBytes(r.blob))}），已省略` };
      return { type: "resource", uri, ...(mimeType ? { mimeType } : {}) };
    }
    case "resource_link": {
      const mimeType = typeof c.mimeType === "string" ? c.mimeType : undefined;
      const name = typeof c.name === "string" ? c.name : "";
      return { type: "resource", uri: String(c.uri ?? ""), ...(name ? { text: `资源链接：${name}` } : {}), ...(mimeType ? { mimeType } : {}) };
    }
    default:
      return { type: "other", summary: `未识别的内容类型 ${String(c.type ?? "（缺失）")}` };
  }
}

/** SDK callTool 返回值（含旧协议 toolResult 形态）→ { content, structured, is_error } */
export function toCallOutcome(result: Record<string, unknown>): { content: McpContent[]; structured?: unknown; is_error: boolean } {
  if (Array.isArray(result.content)) {
    return {
      content: result.content.map(toMcpContent),
      ...(result.structuredContent !== undefined ? { structured: result.structuredContent } : {}),
      is_error: result.isError === true,
    };
  }
  if ("toolResult" in result) return { content: [{ type: "text", text: truncateText(JSON.stringify(result.toolResult)) }], is_error: false };
  return { content: [], is_error: result.isError === true };
}

function truncateText(s: string): string {
  return s.length > MAX_TEXT_CHARS ? `${s.slice(0, MAX_TEXT_CHARS)}\n…（MCP 中转站截断：原文 ${s.length} 字）` : s;
}

function base64DecodedBytes(b64: string): number {
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad);
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : `${Math.ceil(n / 1024)}KB`;
}
