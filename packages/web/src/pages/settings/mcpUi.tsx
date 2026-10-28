// MCP 设置页共用：状态/传输标签、授权对象显示、测试结果面板
import type { ReactNode } from "react";
import type { McpConnState, McpTarget, McpTestRes, McpToolInfo, McpTransport } from "@court/shared/mcp";
import { ApiError, errorText } from "../../api/client.ts";
import { useRegistry } from "../../api/registry.tsx";
import { Seal } from "../../components/Seal.tsx";
import { fmtDuration } from "../../lib/format.ts";
import type { Tone } from "../../lib/labels.ts";

export const TRANSPORT: Record<McpTransport, { label: string; tone: Tone }> = {
  streamable_http: { label: "HTTP", tone: "azure" },
  stdio: { label: "stdio · 容器", tone: "plum" },
};

export const CONN_STATE: Record<McpConnState, { label: string; tone: Tone }> = {
  idle: { label: "闲置", tone: "ink" },
  connecting: { label: "连接中", tone: "azure" },
  ready: { label: "就绪", tone: "jade" },
  error: { label: "出错", tone: "red" },
  disabled: { label: "已停用", tone: "" },
};

/** MCP 接口错误的可读文本：503 unavailable 多半是中转站不可达，而非皇城失联 */
export function mcpErrText(e: unknown): string {
  if (e instanceof ApiError && (e.code === "unavailable" || e.status === 503)) return `MCP 中转站不可达：${e.message}`;
  return errorText(e);
}

export interface TargetView {
  key: string;
  kind: McpTarget["kind"];
  label: string;
  sub?: string;
  missing?: boolean;
}

/** 授权对象 → 显示文字（所有人 / 部门名 / 官员名 + 现任职衔） */
export function useTargetView(): (t: McpTarget) => TargetView {
  const r = useRegistry();
  return (t) => {
    if (t.kind === "all") return { key: "all", kind: "all", label: "所有人" };
    if (t.kind === "dept") {
      const d = r.dept(t.id);
      return { key: `dept:${t.id}`, kind: "dept", label: d?.name ?? t.id, missing: !!r.registry && !d };
    }
    const o = r.officialById(t.id);
    const post = o ? r.postOfOfficial(o.official_id) : undefined;
    const p = post ? r.post(post) : undefined;
    return {
      key: `official:${t.id}`,
      kind: "official",
      label: o?.name ?? t.id,
      sub: p ? r.postLabel(p.post_id, false) : o ? "现无职位" : undefined,
      missing: !!r.registry && !o,
    };
  };
}

export function TargetChip({ v, onRemove }: { v: TargetView; onRemove?: () => void }) {
  return (
    <span className={`mcp-target ${v.kind} ${v.missing ? "missing" : ""}`} title={v.missing ? "名册中已无此对象" : undefined}>
      <span className="mcp-target-kind">{v.kind === "all" ? "众" : v.kind === "dept" ? "部" : "人"}</span>
      <span>{v.label}</span>
      {v.sub && <span className="mcp-target-sub">{v.sub}</span>}
      {onRemove && (
        <button type="button" className="mcp-target-x" onClick={onRemove} aria-label={`移除 ${v.label}`}>
          ✕
        </button>
      )}
    </span>
  );
}

/** 工具参数名（取 input_schema.properties 的键） */
function paramNames(t: McpToolInfo): string[] {
  const props = (t.input_schema as { properties?: Record<string, unknown> } | undefined)?.properties;
  return props && typeof props === "object" ? Object.keys(props) : [];
}

export function ToolList({ tools, render }: { tools: McpToolInfo[]; render?: (t: McpToolInfo) => ReactNode }) {
  if (tools.length === 0) return <div className="muted small">（服务器未报任何工具）</div>;
  return (
    <ul className="mcp-tools">
      {tools.map((t) => {
        const ps = paramNames(t);
        return (
          <li key={t.name} className="mcp-tool">
            {render?.(t)}
            <div className="grow" style={{ minWidth: 0 }}>
              <div className="row wrap" style={{ gap: 6 }}>
                <code className="mcp-tool-name">{t.name}</code>
                {t.title && t.title !== t.name && <span className="serif small">{t.title}</span>}
              </div>
              {t.description && <div className="small muted mcp-tool-desc">{t.description}</div>}
              {ps.length > 0 && (
                <div className="prov-codes" style={{ marginTop: 3 }}>
                  <span className="muted small">参数</span>
                  {ps.map((p) => (
                    <code key={p}>{p}</code>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function TestResult({ res, toolRender }: { res: McpTestRes; toolRender?: (t: McpToolInfo) => ReactNode }) {
  return (
    <div className={`test-res ${res.ok ? "ok" : "bad"}`}>
      <div className="row wrap">
        <Seal text={res.ok ? "通" : "阻"} tone={res.ok ? "jade" : "red"} size={24} stamp />
        <b className="serif">{res.ok ? "连通" : "不通"}</b>
        {res.server_info && (
          <span className="mono small">
            {res.server_info.name} {res.server_info.version}
          </span>
        )}
        {res.ok && <span className="small">工具 {res.tools.length} 个</span>}
        <span className="muted small">耗时 {fmtDuration(res.duration_ms)}</span>
      </div>
      {res.error && <div className="small bad-ink test-text mcp-err">{res.error}</div>}
      {res.ok && <ToolList tools={res.tools} render={toolRender} />}
    </div>
  );
}
