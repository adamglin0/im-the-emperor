// 吏部：单个官员的配置编辑（提示词附加 / 思考强度 / 工具组）+ 配置史（diff、回滚）
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Official, ThinkingLevel } from "@court/shared/types";
import type { ConfigHistoryRow } from "@court/shared/api";
import { hub } from "../../api/client.ts";
import { useRegistry } from "../../api/registry.tsx";
import { Addr, TimeAgo } from "../../components/Addr.tsx";
import { DiffView } from "../../components/DiffView.tsx";
import { Drawer, useConfirm } from "../../components/Overlay.tsx";
import { ErrorBox, Loading, Empty } from "../../components/States.tsx";
import { Tabs } from "../../components/Tabs.tsx";
import { Tag } from "../../components/Tag.tsx";
import { useAction } from "../../hooks/useAction.ts";
import { useQuery } from "../../hooks/useQuery.ts";
import { ALL_TOOL_GROUPS, THINKING_LABEL, TOOL_GROUP_LABEL } from "../../lib/labels.ts";

const THINKING: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** 配置快照 → 可 diff 的文本 */
export function serializeConfig(o: Partial<Official>): string {
  return [
    `模型：${o.model ?? "—"}`,
    `思考：${o.thinking ? `${THINKING_LABEL[o.thinking] ?? o.thinking}（${o.thinking}）` : "—"}`,
    `额外工具组：${(o.extra_tool_groups ?? []).map((g) => TOOL_GROUP_LABEL[g] ?? g).join("、") || "无"}`,
    `禁用工具组：${(o.disabled_tool_groups ?? []).map((g) => TOOL_GROUP_LABEL[g] ?? g).join("、") || "无"}`,
    `状态：${o.status ?? "—"}`,
    "——个人提示词附加——",
    ...(o.prompt_overrides ?? "").split("\n"),
  ].join("\n");
}

export function ConfigDrawer({ post, onClose }: { post: string | null; onClose: () => void }) {
  const r = useRegistry();
  const [tab, setTab] = useState<"edit" | "history">("edit");
  const cfg = useQuery(() => hub.officialConfig(post!), [post], { enabled: !!post, watch: ["config.", "personnel."], interval: 0 });
  const hist = useQuery(() => hub.configHistory(post!), [post], { enabled: !!post, watch: ["config."], interval: 0 });
  const p = post ? r.post(post) : undefined;
  const o = post ? r.officialOf(post) : undefined;

  return (
    <Drawer
      open={!!post}
      onClose={onClose}
      width={760}
      title={
        <span>
          {p?.title ?? post} <span className="muted serif" style={{ fontSize: 14 }}>{o?.name ?? "（空缺）"}</span>
          {p?.approval_sensitive && <span className="sensitive-mark" title="改其配置须皇帝批准">敏</span>}
        </span>
      }
      head={post ? <Link className="btn sm" to={`/officials/${post}`}>官员页</Link> : undefined}
    >
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { key: "edit", label: "改配置" },
          { key: "history", label: "配置史", count: hist.data?.length },
        ]}
      />
      {tab === "edit" &&
        (cfg.initial ? (
          <Loading />
        ) : cfg.data ? (
          <ConfigEditor key={`${post}:${cfg.data.official.config_version}`} post={post!} data={cfg.data} onSaved={() => (cfg.reload(), hist.reload(), r.reload())} />
        ) : (
          <ErrorBox error={cfg.error ?? "此职位无现任官员，无可配置"} onRetry={cfg.reload} />
        ))}
      {tab === "history" && post && <HistoryPanel post={post} rows={hist.data} error={hist.error} loading={hist.initial} onRolledBack={() => (cfg.reload(), hist.reload(), r.reload())} />}
    </Drawer>
  );
}

function ConfigEditor({
  post,
  data,
  onSaved,
}: {
  post: string;
  data: { official: Official; post: { tool_groups: string[]; approval_sensitive: boolean }; effective_tool_groups: string[]; system_prompt: string };
  onSaved: () => void;
}) {
  const { official } = data;
  const [prompt, setPrompt] = useState(official.prompt_overrides ?? "");
  const [thinking, setThinking] = useState<ThinkingLevel>(official.thinking);
  const [extra, setExtra] = useState<string[]>(official.extra_tool_groups ?? []);
  const [disabled, setDisabled] = useState<string[]>(official.disabled_tool_groups ?? []);
  const [reason, setReason] = useState("");
  const [showPrompt, setShowPrompt] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const defaults = new Set(data.post.tool_groups);

  const changes = useMemo(() => {
    const c: { prompt_overrides?: string; thinking?: ThinkingLevel; extra_tool_groups?: string[]; disabled_tool_groups?: string[] } = {};
    if (prompt !== (official.prompt_overrides ?? "")) c.prompt_overrides = prompt;
    if (thinking !== official.thinking) c.thinking = thinking;
    const same = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
    if (!same(extra, official.extra_tool_groups ?? [])) c.extra_tool_groups = extra;
    if (!same(disabled, official.disabled_tool_groups ?? [])) c.disabled_tool_groups = disabled;
    return c;
  }, [prompt, thinking, extra, disabled, official]);
  const dirty = Object.keys(changes).length > 0;

  const toggle = (g: string) => {
    if (defaults.has(g)) setDisabled((d) => (d.includes(g) ? d.filter((x) => x !== g) : [...d, g]));
    else setExtra((d) => (d.includes(g) ? d.filter((x) => x !== g) : [...d, g]));
  };
  const enabled = (g: string) => (defaults.has(g) ? !disabled.includes(g) : extra.includes(g));

  const submit = async () => {
    const ok = await confirm({
      title: "颁下吏部配置",
      body: (
        <>
          <div>
            改动：{Object.keys(changes).map((k) => ({ prompt_overrides: "提示词", thinking: "思考强度", extra_tool_groups: "额外工具组", disabled_tool_groups: "禁用工具组" })[k]).join("、")}
          </div>
          <div className="muted small">下一轮生效；异常（错误率/轮次飙升）时系统自动回滚。</div>
        </>
      ),
      okText: "准",
    });
    if (!ok) return;
    const res = await run(() => hub.proposeConfig({ actor: "emperor", target_post: post, changes, reason: reason || "陛下亲改" }));
    if (res) {
      setResult(res.status === "applied" ? "已生效（下一轮起）" : `已入待批（${res.approval_id ?? ""}）`);
      onSaved();
    }
  };

  return (
    <div className="stack">
      <dl className="kv">
        <dt>官员</dt>
        <dd>
          {official.name} <span className="muted mono small">{official.official_id}</span>
        </dd>
        <dt>模型</dt>
        <dd className="mono">{official.model}</dd>
        <dt>配置版本</dt>
        <dd>v{official.config_version}</dd>
        <dt>现行工具组</dt>
        <dd className="grp-tags">
          {data.effective_tool_groups.map((g) => (
            <Tag key={g} tone={defaults.has(g) || g === "common" ? "" : "gold"}>
              {TOOL_GROUP_LABEL[g] ?? g}
            </Tag>
          ))}
        </dd>
      </dl>

      <div>
        <button className="btn sm ghost" onClick={() => setShowPrompt((v) => !v)}>
          {showPrompt ? "▾" : "▸"} 系统提示词预览（{data.system_prompt.length} 字）
        </button>
        {showPrompt && <pre className="code-block prompt-preview" style={{ marginTop: 6 }}>{data.system_prompt}</pre>}
      </div>

      <div className="field">
        <span className="label">思考强度</span>
        <div className="seg fit">
          {THINKING.map((t) => (
            <button key={t} className={thinking === t ? "active" : ""} onClick={() => setThinking(t)}>
              {THINKING_LABEL[t]}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="label">工具组</span>
        <div className="cfg-groups">
          {ALL_TOOL_GROUPS.filter((g) => g !== "common").map((g) => {
            const def = defaults.has(g);
            const on = enabled(g);
            return (
              <label key={g} className={`cfg-group ${def ? "default" : on ? "extra" : ""} ${on ? "" : "off"}`}>
                <input type="checkbox" checked={on} onChange={() => toggle(g)} />
                {TOOL_GROUP_LABEL[g] ?? g}
                <span className="small muted">{def ? "职位" : on ? "额外" : ""}</span>
              </label>
            );
          })}
        </div>
        <span className="hint">青线为职位默认（取消即禁用）；授予职位之外的工具组为「额外」，例须皇帝批准——朕即批准。</span>
      </div>

      <div className="field">
        <span className="label">个人提示词附加</span>
        <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="如：行文务求简明，先结论后理由。" />
      </div>
      <div className="field">
        <span className="label">事由</span>
        <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="陛下亲改" />
      </div>

      {dirty && (
        <div>
          <div className="small muted" style={{ marginBottom: 4 }}>改动预览</div>
          <DiffView before={serializeConfig(official)} after={serializeConfig({ ...official, ...changes })} labels={["现行", "拟改"]} maxHeight={260} />
        </div>
      )}
      <div className="btn-row">
        <button className="btn primary" disabled={!dirty || pending} onClick={submit}>
          {pending ? "颁行中…" : "颁行"}
        </button>
        <button
          className="btn ghost"
          disabled={!dirty}
          onClick={() => {
            setPrompt(official.prompt_overrides ?? "");
            setThinking(official.thinking);
            setExtra(official.extra_tool_groups ?? []);
            setDisabled(official.disabled_tool_groups ?? []);
          }}
        >
          复原
        </button>
        {result && <Tag tone="jade">{result}</Tag>}
      </div>
    </div>
  );
}

function HistoryPanel({
  post,
  rows,
  error,
  loading,
  onRolledBack,
}: {
  post: string;
  rows: ConfigHistoryRow[] | undefined;
  error: unknown;
  loading: boolean;
  onRolledBack: () => void;
}) {
  const sorted = useMemo(() => [...(rows ?? [])].sort((a, b) => b.version - a.version), [rows]);
  const [sel, setSel] = useState<number | null>(null);
  const confirm = useConfirm();
  const { run, pending } = useAction();
  useEffect(() => {
    if (sel === null && sorted.length) setSel(sorted[0].version);
  }, [sorted, sel]);
  if (loading) return <Loading />;
  if (error && !rows) return <ErrorBox error={error} />;
  if (!sorted.length) return <Empty text="尚无配置史" seal="史" />;
  const cur = sorted.find((x) => x.version === sel) ?? sorted[0];
  const prev = sorted.find((x) => x.version < cur.version);
  const latest = sorted[0].version;

  const rollback = async (row: ConfigHistoryRow) => {
    const ok = await confirm({ title: `回滚至 v${row.version}`, body: "将以该版本的提示词、思考强度、工具组为准，生成新版本。", okText: "回滚", danger: true });
    if (!ok) return;
    const res = await run(() => hub.configRollback({ actor: "emperor", post, version: row.version, reason: `陛下回滚至 v${row.version}` }), "已回滚");
    if (res) onRolledBack();
  };

  return (
    <div className="stack">
      <div className="hist-list">
        {sorted.map((h) => (
          <div key={h.id} className={`hist-item ${h.version === cur.version ? "active" : ""}`} onClick={() => setSel(h.version)}>
            <span className="ver">v{h.version}</span>
            <span className="ellipsis">
              <Addr a={h.actor} /> · {h.reason || "—"}
              <span className="muted small"> · <TimeAgo ms={h.at} /></span>
            </span>
            {h.version === latest ? (
              <Tag tone="jade">现行</Tag>
            ) : (
              <button
                className="btn sm danger"
                disabled={pending}
                onClick={(e) => {
                  e.stopPropagation();
                  void rollback(h);
                }}
              >
                回滚
              </button>
            )}
          </div>
        ))}
      </div>
      <div>
        <div className="small muted" style={{ marginBottom: 4 }}>
          {prev ? `v${prev.version} → v${cur.version}` : `v${cur.version}（初版）`}
        </div>
        <DiffView before={prev ? serializeConfig(prev.snapshot) : ""} after={serializeConfig(cur.snapshot)} labels={[prev ? `v${prev.version}` : "无", `v${cur.version}`]} />
      </div>
    </div>
  );
}
