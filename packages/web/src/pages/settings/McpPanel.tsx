// 设置 · MCP 工具：服务器列表（状态取自中转站）、启停、测试、重启、编辑、删除
import { useEffect, useMemo, useState } from "react";
import type { McpServerStatus, McpServerView, McpTestRes } from "@court/shared/mcp";
import { hub, slowHub } from "../../api/client.ts";
import { Card, Stat } from "../../components/Card.tsx";
import { Modal, useConfirm } from "../../components/Overlay.tsx";
import { Seal } from "../../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../../components/States.tsx";
import { Tag } from "../../components/Tag.tsx";
import { useToast } from "../../components/Toast.tsx";
import { useAction } from "../../hooks/useAction.ts";
import { useQuery } from "../../hooks/useQuery.ts";
import { fmtAgo, fmtDateTime } from "../../lib/format.ts";
import { McpEditor } from "./McpEditor.tsx";
import { CONN_STATE, TRANSPORT, TargetChip, TestResult, mcpErrText, useTargetView } from "./mcpUi.tsx";

type StatusRes = { ok: true; list: McpServerStatus[] } | { ok: false; error: unknown };

export function McpPanel() {
  const q = useQuery(() => hub.mcpServers(), [], { watch: ["mcp."], interval: 60_000 });
  // 中转站不可达（503）不应让全站标记为「皇城失联」，故在此吞掉错误另行显示
  const st = useQuery<StatusRes>(
    () =>
      hub
        .mcpStatus()
        .then((list): StatusRes => ({ ok: true, list }))
        .catch((error: unknown): StatusRes => ({ ok: false, error })),
    [],
    { watch: ["mcp."], interval: 15_000 },
  );
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [editing, setEditing] = useState<McpServerView | "new" | null>(null);
  const [testing, setTesting] = useState<McpServerView | null>(null);

  const list = useMemo(() => [...(q.data ?? [])].sort((a, b) => a.id.localeCompare(b.id)), [q.data]);
  const statusMap = useMemo(() => new Map((st.data?.ok ? st.data.list : []).map((s) => [s.id, s])), [st.data]);
  const brokerDown = st.data && !st.data.ok ? st.data.error : undefined;
  const enabled = list.filter((s) => s.enabled);
  const ready = enabled.filter((s) => statusMap.get(s.id)?.state === "ready");
  const toolTotal = ready.reduce((a, s) => a + (statusMap.get(s.id)?.tool_count ?? 0), 0);

  const reloadAll = () => {
    q.reload();
    st.reload();
  };
  const toggle = async (s: McpServerView) => {
    const r = await run(() => hub.updateMcpServer(s.id, { enabled: !s.enabled, expected_version: s.version }));
    if (!r) return;
    if (r.status === "pending_approval") toast("已呈待批", "info");
    else toast(s.enabled ? `已停用 ${s.name}` : `已启用 ${s.name}`, "ok");
    reloadAll();
  };
  const restart = async (s: McpServerView) => {
    const r = await run(() => slowHub.restartMcpServer(s.id));
    if (!r) return;
    const label = CONN_STATE[r.state]?.label ?? r.state;
    toast(r.state === "error" ? `重连失败：${r.error ?? label}` : `已重连 · ${label}`, r.state === "error" ? "bad" : "ok");
    st.reload();
  };
  const remove = async (s: McpServerView) => {
    const ok = await confirm({
      title: `删除 MCP 服务器：${s.name}`,
      body: (
        <>
          <b>{s.name}</b>（<code>{s.id}</code>）的配置与已存密钥一并删除，获授官员下一轮即失去其工具{s.transport === "stdio" ? "，其容器随之停止" : ""}。
        </>
      ),
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    if (await run(() => hub.deleteMcpServer(s.id, { expected_version: s.version }), "已删除")) reloadAll();
  };

  return (
    <>
      <div className="set-note">
        <Seal text="械" tone="gold" size={24} />
        <div className="grow">
          stdio 服务器各在独立 docker 容器中运行（不入朝廷网络，只读根、资源受限）；HTTP 服务器的地址须从 MCP 中转站容器可达。
          <span className="muted"> 请求头与环境变量视同密钥，只写不读：保存后不回传浏览器。</span>
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="服务器" value={q.data ? list.length : "—"} unit="个" sub={`stdio ${list.filter((s) => s.transport === "stdio").length} · HTTP ${list.filter((s) => s.transport === "streamable_http").length}`} />
        <Stat label="已启用" value={q.data ? enabled.length : "—"} unit="个" tone="azure" sub={`停用 ${list.length - enabled.length}`} />
        <Stat label="就绪" value={q.data && st.data?.ok ? ready.length : "—"} unit="个" tone="jade" sub={brokerDown ? "中转站不可达" : `出错 ${enabled.filter((s) => statusMap.get(s.id)?.state === "error").length}`} />
        <Stat label="工具总数" value={q.data && st.data?.ok ? toolTotal : "—"} unit="个" tone="red" sub="就绪服务器合计" />
      </div>

      {brokerDown !== undefined && <ErrorBox error={new Error(mcpErrText(brokerDown))} onRetry={st.reload} />}

      <Card
        title="MCP 服务器"
        sub="授权对象下一轮自动获得其工具；停用即收回"
        actions={
          <button className="btn primary sm" onClick={() => setEditing("new")}>
            ＋ 新增服务器
          </button>
        }
      >
        <QueryView
          q={q}
          empty={
            <Empty text="尚未接入任何 MCP 服务器" seal="空">
              <button className="btn gold sm" onClick={() => setEditing("new")}>
                接入第一个
              </button>
            </Empty>
          }
        >
          {() => (
            <div className="prov-grid">
              {list.map((s) => (
                <McpTile
                  key={s.id}
                  s={s}
                  status={statusMap.get(s.id)}
                  statusKnown={!!st.data?.ok}
                  busy={pending}
                  onToggle={() => void toggle(s)}
                  onTest={() => setTesting(s)}
                  onRestart={() => void restart(s)}
                  onEdit={() => setEditing(s)}
                  onDelete={() => void remove(s)}
                />
              ))}
            </div>
          )}
        </QueryView>
      </Card>

      {editing && <McpEditor initial={editing === "new" ? null : editing} all={list} onClose={() => setEditing(null)} onSaved={reloadAll} />}
      {testing && <McpTestModal s={testing} onClose={() => setTesting(null)} />}
    </>
  );
}

function McpTile({
  s,
  status,
  statusKnown,
  busy,
  onToggle,
  onTest,
  onRestart,
  onEdit,
  onDelete,
}: {
  s: McpServerView;
  status?: McpServerStatus;
  statusKnown: boolean;
  busy: boolean;
  onToggle: () => void;
  onTest: () => void;
  onRestart: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const tv = useTargetView();
  const tr = TRANSPORT[s.transport] ?? { label: s.transport, tone: "" };
  const state = !s.enabled ? "disabled" : status?.state;
  const cs = state ? CONN_STATE[state] : undefined;
  const stale = status && status.version !== s.version;
  const cls = !s.enabled ? "off" : state === "error" ? "err" : state === "ready" ? "on" : "";
  return (
    <article className={`prov-tile mcp-tile ${cls}`}>
      <header className="prov-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="prov-name serif">{s.name}</div>
          <div className="mono small muted ellipsis">{s.id}</div>
        </div>
        <div className="prov-tags">
          <Tag tone={tr.tone}>{tr.label}</Tag>
          {cs ? (
            <Tag tone={cs.tone} title={status?.error}>
              {state === "connecting" && <span className="dot-state pulse" />}
              {cs.label}
            </Tag>
          ) : (
            <Tag outline title={statusKnown ? "中转站尚未加载此服务器" : "中转站不可达"}>
              {statusKnown ? "未加载" : "状态未知"}
            </Tag>
          )}
        </div>
      </header>

      {s.description && <div className="small mcp-desc">{s.description}</div>}
      {s.enabled && status?.state === "error" && status.error && <div className="small bad-ink mcp-err">{status.error}</div>}

      <dl className="kv prov-kv">
        <dt>授权</dt>
        <dd>
          {s.targets.length === 0 ? (
            <span className="warn-ink">未授权任何人</span>
          ) : (
            <div className="mcp-targets">
              {s.targets.map((t) => {
                const v = tv(t);
                return <TargetChip key={v.key} v={v} />;
              })}
            </div>
          )}
        </dd>
        <dt>工具</dt>
        <dd>
          {status?.tool_count !== undefined ? `${status.tool_count} 个` : <span className="muted">—</span>}
          {s.tool_allow && s.tool_allow.length > 0 && <span className="muted small"> · 白名单 {s.tool_allow.length} 项</span>}
          {status?.calls ? (
            <span className="muted small">
              {" "}
              · 调用 {status.calls} 次{status.errors ? `，错 ${status.errors}` : ""}
            </span>
          ) : null}
        </dd>
        {s.transport === "streamable_http" ? (
          <>
            <dt>地址</dt>
            <dd className="mono small prov-url">{s.url}</dd>
            {s.header_keys.length > 0 && (
              <>
                <dt>请求头</dt>
                <dd className="prov-codes">
                  {s.header_keys.map((h) => (
                    <code key={h}>{h}</code>
                  ))}
                </dd>
              </>
            )}
          </>
        ) : (
          <>
            <dt>命令</dt>
            <dd className="mono small prov-url">
              {[s.command, ...(s.args ?? [])].join(" ")}
              <div className="muted">
                {s.image} · {s.network === "none" ? "断网" : "可联网"} · {s.memory_mb ?? 512}MB · {s.cpus ?? 1} CPU
              </div>
            </dd>
            {s.env_keys.length > 0 && (
              <>
                <dt>环境变量</dt>
                <dd className="prov-codes">
                  {s.env_keys.map((h) => (
                    <code key={h}>{h}</code>
                  ))}
                </dd>
              </>
            )}
          </>
        )}
        {status?.container && (
          <>
            <dt>容器</dt>
            <dd className="mono small prov-url">{status.container}</dd>
          </>
        )}
        <dt>修订</dt>
        <dd className="small">
          v{s.version} · <span title={fmtDateTime(s.updated_at)}>{fmtAgo(s.updated_at)}</span>
          {stale && <span className="warn-ink"> · 中转站仍载 v{status!.version}</span>}
        </dd>
      </dl>

      <div className="prov-foot">
        <label className="mcp-switch" title={s.enabled ? "停用" : "启用"}>
          <input type="checkbox" role="switch" checked={s.enabled} disabled={busy} onChange={onToggle} />
          <span className="mcp-switch-track" aria-hidden />
          <span className="small">{s.enabled ? "启用" : "停用"}</span>
        </label>
        <span className="grow" />
        <button className="btn sm" disabled={busy} onClick={onTest}>
          测试
        </button>
        <button className="btn sm" disabled={busy || !s.enabled} title={s.enabled ? "断开并重连（stdio 即重启容器）" : "已停用"} onClick={onRestart}>
          重启
        </button>
        <button className="btn sm" disabled={busy} onClick={onEdit}>
          编辑
        </button>
        <button className="btn sm danger" disabled={busy} onClick={onDelete}>
          删除
        </button>
      </div>
    </article>
  );
}

function McpTestModal({ s, onClose }: { s: McpServerView; onClose: () => void }) {
  const [res, setRes] = useState<McpTestRes | null>(null);
  const [err, setErr] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    setRes(null);
    setErr(undefined);
    try {
      setRes(await slowHub.testMcpServer(s.id));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void go();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.id]);
  return (
    <Modal open onClose={onClose} title={`测试 · ${s.name}`} width={640}>
      <div className="muted small" style={{ marginBottom: 10 }}>
        以已存配置临时连接、列出工具后即断开{s.transport === "stdio" ? "（另起一个测试容器，首次拉取镜像可能较慢）" : ""}。
      </div>
      {busy && <Loading text="连接中" />}
      {res && <TestResult res={res} />}
      {err !== undefined && <ErrorBox error={new Error(mcpErrText(err))} />}
      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" onClick={onClose}>
          罢
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void go()}>
          再测
        </button>
      </div>
    </Modal>
  );
}
