// MCP 动态工具（docs/mcp.md §4）：把中转站（broker）给本官员的工具清单装成 pi 工具。
//   - 工具名 mcpToolName(server, tool)；label「MCP·<server>」；description「【MCP·<服务器名>】<工具描述>」（≤1024 字）
//   - parameters = MCP inputSchema（清洗后）；无法编译的 schema 退为宽松对象，并把原 schema 摘要写进描述
//   - execute → mcp.call → 文本拼接 + untrusted() 标注 + 8KB 截断；图片（≤1MB）直接给模型；is_error → isError
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { validateToolArguments, type ImageContent, type TextContent } from "@earendil-works/pi-ai";
import { LIMITS, MCP_LIMITS, mcpToolName, truncate, type McpCallRes, type McpCatalog, type McpClient, type McpToolInfo } from "@court/shared";
import type { ToolContext } from "./tool-context.ts";
import { clip, errorResult, untrustedBlock } from "./tools/_util.ts";
import { withEndGuard } from "./tools/end-guard.ts";

/** 描述上限（字符） */
export const MCP_DESC_MAX = 1024;
/** schema 退化时，描述里工具本身说明的上限（字符）：其余篇幅留给原 schema 摘要 */
const DESC_BODY_MAX_WITH_SCHEMA_NOTE = 400;
/** 超过此大小的 schema 直接退化（过大的 schema 浪费上下文，也易被模型提供商拒收） */
const SCHEMA_MAX_BYTES = 16 * 1024;
/** 超过此嵌套深度的 schema 直接退化（防编译/递归遍历过深） */
const SCHEMA_MAX_DEPTH = 32;
/** 图片直接给模型的上限（解码后字节；单张与单次结果合计都按此上限） */
export const MCP_IMAGE_MAX_BYTES = 1024 * 1024;
/** 各家模型提供商都接受的图片格式（如 svg 会被拒收、整轮失败） */
const MODEL_IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** 包裹前正文的上限：留出抬头、不可信标注与提示的空间（中文 3 字节/字），整体仍 ≤ toolOutputMaxBytes */
const TEXT_MAX_BYTES = LIMITS.toolOutputMaxBytes - 1024;

const EMPTY_SCHEMA = { type: "object", properties: {} } as const;
const PERMISSIVE_SCHEMA = { type: "object", additionalProperties: true } as const;

export interface SanitizedSchema {
  schema: Record<string, unknown>;
  /** 顶层非 object 型，已包成 { input: <原 schema> }：调用时取 args.input */
  wrapped: boolean;
  /** 原 schema 无法使用，已退为宽松对象；值为原 schema 的 JSON（截短后写入描述） */
  fallback?: string;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 深拷贝并清洗：去掉 $schema；外部 $ref（非 # 开头）替换为任意值；
 * required 里列了 properties 中没有的键（模型无从得知其类型，部分提供商直接拒收）→ 删去并去重。
 */
function scrub(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrub);
  if (!isPlainObject(v)) return v;
  if (typeof v.$ref === "string" && !v.$ref.startsWith("#")) {
    const { description } = v as { description?: unknown };
    return typeof description === "string" ? { description } : {};
  }
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "$schema") continue;
    o[k] = scrub(x);
  }
  if (isPlainObject(o.properties) && Array.isArray(o.required) && !REQUIRED_MAY_REFER_ELSEWHERE.some((k) => o[k] !== undefined)) {
    const known = o.properties;
    o.required = [...new Set(o.required)].filter((x) => typeof x !== "string" || Object.hasOwn(known, x));
  }
  return o;
}

/** 这些关键字可能在别处定义 required 所指的键：有它们时不动 required */
const REQUIRED_MAY_REFER_ELSEWHERE = ["patternProperties", "allOf", "anyOf", "oneOf", "dependentSchemas", "if", "then", "else"];

/** 嵌套深度（对象/数组层数） */
function nestingDepth(v: unknown): number {
  if (Array.isArray(v)) return 1 + v.reduce<number>((m, x) => Math.max(m, nestingDepth(x)), 0);
  if (isPlainObject(v)) return 1 + Object.values(v).reduce<number>((m, x) => Math.max(m, nestingDepth(x)), 0);
  return 0;
}

/**
 * 包一层后内部 $ref 的指向随之下移：`#` 与 `#/<非定义区>/…` 改指 `#/properties/input…`；
 * `#/$defs/…`、`#/definitions/…` 已随定义区提到新根，保持不变。
 */
function rebaseRefsUnderInput(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(rebaseRefsUnderInput);
  if (!isPlainObject(v)) return v;
  const o: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "$ref" && typeof x === "string" && (x === "#" || (x.startsWith("#/") && !/^#\/(\$defs|definitions)(\/|$)/.test(x)))) {
      o[k] = `#/properties/input${x.slice(1)}`;
    } else o[k] = rebaseRefsUnderInput(x);
  }
  return o;
}

const JSON_TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);
const SUBSCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];
const SUBSCHEMA_LISTS = ["anyOf", "oneOf", "allOf", "prefixItems"];
const SUBSCHEMA_ONE = ["items", "additionalProperties", "not", "if", "then", "else", "contains", "propertyNames", "unevaluatedProperties", "additionalItems"];
/** 顶层出现即须包一层的组合关键字（Anthropic 等拒收顶层 anyOf/oneOf/allOf） */
const TOP_LEVEL_COMBINATORS = ["anyOf", "oneOf", "allOf", "not", "if", "then", "else"];

/** 解析内部 JSON Pointer（#/a/b） */
function resolvePointer(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let key: string;
    try {
      key = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (!isPlainObject(cur) && !Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[key];
    if (cur === undefined) return undefined;
  }
  return cur;
}

/** 结构检查：type 合法、子 schema 形状正确、required 为字符串数组、内部 $ref 可解析。返回第一处问题 */
function structuralProblem(root: Record<string, unknown>): string | undefined {
  const walk = (node: unknown, path: string): string | undefined => {
    if (typeof node === "boolean") return undefined;
    if (!isPlainObject(node)) return `${path} 不是 schema 对象`;
    const t = node.type;
    if (t !== undefined) {
      const ts = Array.isArray(t) ? t : [t];
      if (!ts.length || ts.some((x) => typeof x !== "string" || !JSON_TYPES.has(x))) return `${path}.type 不合法`;
    }
    if (node.required !== undefined && !(Array.isArray(node.required) && node.required.every((x) => typeof x === "string"))) return `${path}.required 不合法`;
    if (typeof node.$ref === "string" && resolvePointer(root, node.$ref) === undefined) return `${path}.$ref 无法解析`;
    for (const k of SUBSCHEMA_MAPS) {
      const m = node[k];
      if (m === undefined) continue;
      if (!isPlainObject(m)) return `${path}.${k} 不合法`;
      for (const [name, sub] of Object.entries(m)) {
        const r = walk(sub, `${path}.${k}.${name}`);
        if (r) return r;
      }
    }
    for (const k of SUBSCHEMA_LISTS) {
      const l = node[k];
      if (l === undefined) continue;
      if (!Array.isArray(l)) return `${path}.${k} 不合法`;
      for (let i = 0; i < l.length; i++) {
        const r = walk(l[i], `${path}.${k}[${i}]`);
        if (r) return r;
      }
    }
    for (const k of SUBSCHEMA_ONE) {
      const sub = node[k];
      if (sub === undefined) continue;
      const r = Array.isArray(sub) ? sub.map((x, i) => walk(x, `${path}.${k}[${i}]`)).find(Boolean) : walk(sub, `${path}.${k}`);
      if (r) return r;
    }
    return undefined;
  };
  return walk(root, "#");
}

/** pi 校验参数时会编译 schema：先试编译一次，编译不了（而非「参数不符」）即视为不可用 */
function compiles(schema: Record<string, unknown>): boolean {
  try {
    validateToolArguments({ name: "probe", description: "", parameters: schema as never }, { type: "toolCall", id: "probe", name: "probe", arguments: {} });
    return true;
  } catch (e) {
    return /^Validation failed for tool/.test((e as Error)?.message ?? "");
  }
}

/** 顶层不是纯 object 型：包成 { input: <原 schema> }，定义区提到新根，内部 $ref 随之改指 */
function wrapUnderInput(schema: Record<string, unknown>): Record<string, unknown> {
  const { $defs, definitions, ...inner } = schema;
  return {
    type: "object",
    properties: { input: rebaseRefsUnderInput(inner) },
    required: ["input"],
    ...($defs !== undefined ? { $defs: rebaseRefsUnderInput($defs) } : {}),
    ...(definitions !== undefined ? { definitions: rebaseRefsUnderInput(definitions) } : {}),
  };
}

/** MCP inputSchema → pi 工具 parameters（顶层必为 object；不可编译则退为宽松对象） */
export function sanitizeSchema(raw: unknown): SanitizedSchema {
  if (raw === undefined || raw === null || (isPlainObject(raw) && Object.keys(raw).length === 0)) return { schema: { ...EMPTY_SCHEMA, properties: {} }, wrapped: false };
  let json: string;
  try {
    json = JSON.stringify(raw) ?? "null";
  } catch {
    return { schema: { ...PERMISSIVE_SCHEMA }, wrapped: false, fallback: "（schema 无法序列化）" };
  }
  const fallback = (): SanitizedSchema => ({ schema: { ...PERMISSIVE_SCHEMA }, wrapped: false, fallback: cutChars(json, MCP_DESC_MAX) });
  if (!isPlainObject(raw)) return fallback();
  if (Buffer.byteLength(json, "utf8") > SCHEMA_MAX_BYTES) return fallback();
  let schema = scrub(JSON.parse(json)) as Record<string, unknown>;
  if (nestingDepth(schema) > SCHEMA_MAX_DEPTH) return fallback();
  // type: ["object", "null"] 等：工具参数总是对象，按 object 处理
  if (Array.isArray(schema.type) && schema.type.includes("object")) schema = { ...schema, type: "object" };
  if (schema.type === undefined && (isPlainObject(schema.properties) || schema.required !== undefined)) schema = { ...schema, type: "object" };
  let wrapped = false;
  if (schema.type !== "object" || TOP_LEVEL_COMBINATORS.some((k) => schema[k] !== undefined)) {
    // 顶层不是对象或带组合关键字：包一层（模型提供商要求工具参数为对象、顶层不得有 anyOf 等）
    schema = wrapUnderInput(schema);
    wrapped = true;
  }
  if (schema.properties === undefined && schema.additionalProperties === undefined) schema = { ...schema, properties: {} };
  if (structuralProblem(schema) !== undefined || !compiles(schema)) return fallback();
  return { schema, wrapped };
}

/** 工具描述：【MCP·服务器名】标题：描述；schema 退化时附原 schema 摘要。总长 ≤ MCP_DESC_MAX */
export function mcpDescription(serverName: string, tool: McpToolInfo, fallback?: string): string {
  const title = tool.title && tool.title !== tool.name ? `${tool.title}：` : "";
  const body = `【MCP·${serverName}】${title}${(tool.description ?? "").trim() || "（无说明）"}`;
  if (fallback === undefined) return cutChars(body, MCP_DESC_MAX);
  const base = cutChars(body, DESC_BODY_MAX_WITH_SCHEMA_NOTE);
  const notePrefix = "\n（此工具的参数 schema 无法直接使用，已放宽为任意对象；请按以下原始 schema 填写参数：";
  const room = Math.max(0, MCP_DESC_MAX - base.length - notePrefix.length - 1);
  return `${base}${notePrefix}${cutChars(fallback, room)}）`;
}

/** 按字符截到 max（含省略号） */
function cutChars(s: string, max: number): string {
  if (s.length <= max) return s;
  return max <= 0 ? "" : `${s.slice(0, max - 1)}…`;
}

/** 把 base64 解码后的大致字节数 */
function base64Bytes(data: string): number {
  const len = data.replace(/\s/g, "").length;
  const pad = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

/** broker 调用结果 → pi 工具结果 */
export function mcpCallToResult(ctx: Pick<ToolContext, "log">, serverName: string, toolName: string, res: McpCallRes): AgentToolResult<any> {
  const parts: string[] = [];
  const images: ImageContent[] = [];
  let imageBytes = 0;
  for (const c of res.content ?? []) {
    switch (c.type) {
      case "text":
        parts.push(c.text);
        break;
      case "image": {
        const bytes = base64Bytes(c.data ?? "");
        const size = `${Math.ceil(bytes / 1024)}KB`;
        if (!c.data || !MODEL_IMAGE_MIME_TYPES.has(c.mimeType ?? "")) {
          parts.push(`［图片 ${c.mimeType ?? "?"}（${size}）格式不受支持，已略去］`);
        } else if (imageBytes + bytes > MCP_IMAGE_MAX_BYTES) {
          parts.push(`［图片 ${c.mimeType}（${size}）过大（单次结果的图片合计上限 ${MCP_IMAGE_MAX_BYTES / 1024}KB），已略去］`);
        } else {
          imageBytes += bytes;
          images.push({ type: "image", data: c.data, mimeType: c.mimeType });
          parts.push(`［图片 ${c.mimeType}，${size}，见附图］`);
        }
        break;
      }
      case "resource":
        parts.push(`［资源 ${c.uri}${c.mimeType ? `（${c.mimeType}）` : ""}］${c.text ? `\n${c.text}` : ""}`);
        break;
      case "other":
        parts.push(`［${c.summary}］`);
        break;
      default:
        parts.push(`［未知内容：${truncate(JSON.stringify(c), 200).text}］`);
    }
  }
  if (res.structured !== undefined && !parts.some((p) => p.trim())) {
    try {
      parts.push(JSON.stringify(res.structured));
    } catch {
      /* 忽略不可序列化的结构化结果 */
    }
  }
  const raw = parts.join("\n").trim() || "（无输出）";
  const source = `MCP·${serverName}/${toolName}`;
  const block = untrustedBlock(ctx as ToolContext, source, clip(raw, TEXT_MAX_BYTES));
  const head = res.is_error ? `MCP 工具 ${toolName}（${serverName}）报错，耗时 ${res.duration_ms}ms：` : `MCP 工具 ${toolName}（${serverName}）返回，耗时 ${res.duration_ms}ms：`;
  const tail = [block.hint, res.is_error ? "可按错误信息修正参数后重试，或改用其他办法。" : undefined].filter(Boolean).join(" ");
  const text = clip(`${head}\n${block.text}${tail ? `\n提示：${tail}` : ""}`);
  const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...images];
  return {
    content,
    details: { server: serverName, tool: toolName, duration_ms: res.duration_ms, is_error: res.is_error, images: images.length || undefined },
    ...(res.is_error ? { isError: true } : {}),
  };
}

/**
 * 服务器暂时出错（清单里无工具、带 error）时沿用上次装上的工具：调用时由 broker 报错，比工具忽增忽减更稳。
 * 服务器不在新清单里（停用/删除/撤销授权）则不沿用。
 */
export function keepToolsOfFailingServers(fetched: McpCatalog, previous: McpCatalog | undefined): McpCatalog {
  if (!previous) return fetched;
  const previousTools = new Map((previous.servers ?? []).map((s) => [s.id, s.tools ?? []]));
  return {
    ...fetched,
    servers: (fetched.servers ?? []).map((s) => {
      const kept = previousTools.get(s.id);
      return s.error && !s.tools?.length && kept?.length ? { ...s, tools: kept } : s;
    }),
  };
}

/** 清单 → 工具（同名去重；每服务器至多 maxToolsPerServer 个）。exclude：已被基础工具占用的名字 */
export function buildMcpTools(catalog: McpCatalog, mcp: McpClient, ctx: ToolContext, exclude: Set<string> = new Set()): AgentTool<any>[] {
  const out: AgentTool<any>[] = [];
  const seen = new Set(exclude);
  for (const s of catalog.servers ?? []) {
    const serverName = s.name || s.id;
    for (const info of (s.tools ?? []).slice(0, MCP_LIMITS.maxToolsPerServer)) {
      if (typeof info?.name !== "string" || !info.name) continue;
      const name = mcpToolName(s.id, info.name);
      if (seen.has(name)) {
        ctx.log("mcp_tool_skipped", { server: s.id, tool: info.name, name, reason: "duplicate" });
        continue;
      }
      seen.add(name);
      try {
        out.push(withEndGuard(ctx, buildMcpTool(s.id, serverName, info, name, mcp, ctx)));
      } catch (e) {
        // 单个工具装配失败不连累同批其他工具
        ctx.log("mcp_tool_skipped", { server: s.id, tool: info.name, name, reason: (e as Error)?.message ?? String(e) });
      }
    }
  }
  return out;
}

/** 单个 MCP 工具 → pi 工具（execute 永不抛出：失败转成 isError 结果） */
function buildMcpTool(serverId: string, serverName: string, info: McpToolInfo, name: string, mcp: McpClient, ctx: ToolContext): AgentTool<any> {
  const sanitized = sanitizeSchema(info.input_schema);
  if (sanitized.fallback !== undefined) ctx.log("mcp_schema_fallback", { server: serverId, tool: info.name });
  const label = `MCP·${serverId}`;
  return {
    name,
    label,
    description: mcpDescription(serverName, info, sanitized.fallback),
    parameters: sanitized.schema as never,
    async execute(_toolCallId, params) {
      const given = (params ?? {}) as Record<string, unknown>;
      const inner = sanitized.wrapped ? given.input : given;
      // MCP 参数须为对象：包过一层且 input 不是对象时原样包回 { input }
      const args = isPlainObject(inner) ? inner : sanitized.wrapped ? { input: inner } : {};
      try {
        const res = await mcp.call({ server: serverId, tool: info.name, arguments: args, trace_id: ctx.turn().trace_id });
        return mcpCallToResult(ctx, serverName, info.name, res);
      } catch (e) {
        return errorResult(`${label}/${info.name} 调用`, e);
      }
    },
  };
}
