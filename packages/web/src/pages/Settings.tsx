// 设置：模型提供商（pi-ai 内置 / 自定义 / 旧式）——凭据经网关交互式登录存入，密钥永不回传
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import type { CustomProviderSpec, ProviderAuthType, ProviderInfo, ProviderLoginEvent, ProviderLoginSession, ProviderModelInfo, ProviderTestRes } from "@court/shared/api";
import { errorText, hub } from "../api/client.ts";
import { Card, PageHead, Stat } from "../components/Card.tsx";
import { Drawer, Modal, useConfirm } from "../components/Overlay.tsx";
import { Seal } from "../components/Seal.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tag } from "../components/Tag.tsx";
import { useToast } from "../components/Toast.tsx";
import { useAction } from "../hooks/useAction.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { fmtAgo, fmtDateTime, fmtDuration, fmtTokens } from "../lib/format.ts";
import type { Tone } from "../lib/labels.ts";
import "../styles/pages/settings.css";

const KIND: Record<ProviderInfo["kind"], { label: string; tone: Tone }> = {
  builtin: { label: "内置", tone: "azure" },
  custom: { label: "自定义", tone: "plum" },
  legacy: { label: "旧式", tone: "gold" },
};
const AUTH_LABEL: Record<ProviderAuthType, string> = { api_key: "API 密钥", oauth: "订阅登录 (OAuth)" };
const API_OPTIONS: { id: string; label: string }[] = [
  { id: "openai-completions", label: "OpenAI Chat Completions（多数兼容服务）" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
];
const SESSION_STATE: Record<ProviderLoginSession["state"], { label: string; tone: Tone }> = {
  running: { label: "进行中", tone: "azure" },
  awaiting_input: { label: "待陛下示下", tone: "gold" },
  done: { label: "已成", tone: "jade" },
  error: { label: "失败", tone: "red" },
  cancelled: { label: "已中止", tone: "ink" },
};
const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;
const URL_RE = /^https?:\/\/\S+$/i;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;

/** 鉴权来源的可读标签 */
function sourceLabel(src?: string): string {
  if (!src) return "已就绪";
  if (/^[A-Z][A-Z0-9_]+$/.test(src)) return `环境变量 ${src}`;
  if (/stored/i.test(src)) return "网关凭据库";
  if (/keyless|none|无鉴权|无需密钥/i.test(src)) return "无需鉴权";
  return src;
}
const isEnvSource = (src?: string) => !!src && /^[A-Z][A-Z0-9_]+$/.test(src);

/** 每百万 token 美元价 */
function fmtPerM(usd: number): string {
  if (!usd) return "0";
  return usd < 1 ? `$${+usd.toFixed(3)}` : `$${+usd.toFixed(2)}`;
}

function sortProviders(list: ProviderInfo[]): ProviderInfo[] {
  const kindRank = { builtin: 0, custom: 1, legacy: 2 } as const;
  return [...list].sort((a, b) => Number(b.configured) - Number(a.configured) || kindRank[a.kind] - kindRank[b.kind] || a.name.localeCompare(b.name, "zh-CN"));
}

interface LoginTarget {
  provider: ProviderInfo;
  session: ProviderLoginSession;
}

export default function SettingsPage() {
  const q = useQuery(() => hub.providers(), [], { watch: ["provider."], interval: 60_000 });
  const { run, pending } = useAction();
  const confirm = useConfirm();
  const toast = useToast();
  const [filter, setFilter] = useState("");
  const [login, setLogin] = useState<LoginTarget | null>(null);
  const [testing, setTesting] = useState<ProviderInfo | null>(null);
  const [browsing, setBrowsing] = useState<ProviderInfo | null>(null);
  const [editing, setEditing] = useState<ProviderInfo | "new" | null>(null);

  const list = useMemo(() => sortProviders(q.data ?? []), [q.data]);
  const enabled = list.filter((p) => p.configured);
  const builtinIdle = list.filter((p) => !p.configured && p.kind === "builtin");
  const customIdle = list.filter((p) => !p.configured && p.kind !== "builtin");
  const k = filter.trim().toLowerCase();
  const builtinShown = k ? builtinIdle.filter((p) => `${p.id} ${p.name} ${p.apis.join(" ")}`.toLowerCase().includes(k)) : builtinIdle;

  const startLogin = async (p: ProviderInfo, type: ProviderAuthType) => {
    const s = await run(() => hub.startProviderLogin(p.id, type));
    if (s) setLogin({ provider: p, session: s });
  };
  const logout = async (p: ProviderInfo) => {
    const ok = await confirm({
      title: `清除凭据：${p.name}`,
      body: (
        <>
          网关凭据库中 <b>{p.name}</b> 的{p.credential ? AUTH_LABEL[p.credential.type] : "凭据"}将被删除。
          {p.env_vars?.length ? <div className="muted small" style={{ marginTop: 6 }}>若环境变量（{p.env_vars.join(" / ")}）中仍有密钥，该提供商仍将可用。</div> : null}
        </>
      ),
      okText: "清除",
      danger: true,
    });
    if (!ok) return;
    const r = await run(() => hub.logoutProvider(p.id));
    if (!r) return;
    if (r.configured) toast(`已清除存储凭据；仍由${sourceLabel(r.source)}生效`, "info");
    else toast("凭据已清除", "ok");
    q.reload();
  };
  const remove = async (p: ProviderInfo) => {
    const ok = await confirm({
      title: `删除自定义提供商：${p.name}`,
      body: <>其地址、模型目录与已存密钥一并删除。模型池中引用 <code>{p.id}/…</code> 的模型将无法应试或任用。</>,
      okText: "删除",
      danger: true,
    });
    if (!ok) return;
    if (await run(() => hub.deleteCustomProvider(p.id), "已删除")) q.reload();
  };

  const tileProps = {
    busy: pending,
    onLogin: (p: ProviderInfo, t: ProviderAuthType) => void startLogin(p, t),
    onTest: setTesting,
    onModels: setBrowsing,
    onLogout: (p: ProviderInfo) => void logout(p),
    onEdit: (p: ProviderInfo) => setEditing(p),
    onDelete: (p: ProviderInfo) => void remove(p),
  };

  return (
    <div className="page settings-page">
      <PageHead title="设置" lede="模型提供商：配置凭据、测试连通、浏览模型目录、选入科举。" />
      <div className="set-note">
        <Seal text="密" tone="gold" size={24} />
        <div className="grow">
          密钥仅存于网关（<code>data/gateway/credentials.json</code>），不会回传到浏览器；环境变量中的密钥同样生效。
          <span className="muted"> 配置后可于「模型」中挑选，入池科举。</span>
        </div>
      </div>

      <div className="grid g4" style={{ marginBottom: 16 }}>
        <Stat label="已启用" value={q.data ? enabled.length : "—"} unit="家" tone="jade" sub={enabled.length ? truncateNames(enabled) : "尚无"} />
        <Stat label="内置提供商" value={q.data ? list.filter((p) => p.kind === "builtin").length : "—"} unit="家" tone="azure" sub="pi-ai 自带" />
        <Stat label="自定义" value={q.data ? list.filter((p) => p.kind === "custom").length : "—"} unit="家" sub={`旧式 ${list.filter((p) => p.kind === "legacy").length}`} />
        <Stat label="可用模型" value={q.data ? enabled.reduce((a, p) => a + p.model_count, 0) : "—"} unit="个" tone="red" sub="已启用者目录合计" />
      </div>

      <QueryView q={q} empty={<Empty text="网关未报任何提供商" seal="空" />}>
        {() => (
          <div className="stack">
            <Card title="已启用" sub="鉴权齐备，可经网关调用">
              {enabled.length === 0 ? (
                <Empty text="尚无已启用的提供商，请于下方择一配置" seal="未" />
              ) : (
                <div className="prov-grid">
                  {enabled.map((p) => (
                    <ProviderTile key={p.id} p={p} {...tileProps} />
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="内置提供商"
              sub={`pi-ai 自带 · 未配置 ${builtinIdle.length} 家`}
              actions={<input type="search" className="set-search" placeholder="筛选：名称 / ID / 接口" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="筛选内置提供商" />}
            >
              {builtinShown.length === 0 ? (
                <Empty text={k ? "无匹配的提供商" : "内置提供商皆已启用"} seal={k ? "寻" : "全"} />
              ) : (
                <div className="prov-grid">
                  {builtinShown.map((p) => (
                    <ProviderTile key={p.id} p={p} {...tileProps} />
                  ))}
                </div>
              )}
            </Card>

            <Card
              title="自定义提供商"
              sub="OpenAI 兼容等自建 / 第三方服务；已启用者见上"
              actions={
                <button className="btn primary sm" onClick={() => setEditing("new")}>
                  ＋ 新增自定义提供商
                </button>
              }
            >
              {customIdle.length === 0 ? (
                <Empty text={list.some((p) => p.kind === "custom") ? "自定义提供商皆已启用" : "尚无自定义提供商"} seal="自" />
              ) : (
                <div className="prov-grid">
                  {customIdle.map((p) => (
                    <ProviderTile key={p.id} p={p} {...tileProps} />
                  ))}
                </div>
              )}
            </Card>
          </div>
        )}
      </QueryView>

      {login && (
        <LoginModal
          key={login.session.id}
          provider={login.provider}
          initial={login.session}
          onClose={() => setLogin(null)}
          onDone={() => {
            toast(`${login.provider.name}：${login.session.type === "oauth" ? "登录成功" : "密钥已存入网关"}`, "ok");
            q.reload();
          }}
        />
      )}
      {testing && <TestModal p={testing} onClose={() => setTesting(null)} />}
      {browsing && <ModelsDrawer p={browsing} onClose={() => setBrowsing(null)} />}
      {editing && <CustomProviderModal initial={editing === "new" ? null : editing} all={list} onClose={() => setEditing(null)} onSaved={q.reload} />}
    </div>
  );
}

function truncateNames(ps: ProviderInfo[]): string {
  const names = ps.map((p) => p.name);
  return names.length <= 3 ? names.join("、") : `${names.slice(0, 3).join("、")} 等`;
}

// ───────── 提供商卡 ─────────
function ProviderTile({
  p,
  busy,
  onLogin,
  onTest,
  onModels,
  onLogout,
  onEdit,
  onDelete,
}: {
  p: ProviderInfo;
  busy: boolean;
  onLogin: (p: ProviderInfo, t: ProviderAuthType) => void;
  onTest: (p: ProviderInfo) => void;
  onModels: (p: ProviderInfo) => void;
  onLogout: (p: ProviderInfo) => void;
  onEdit: (p: ProviderInfo) => void;
  onDelete: (p: ProviderInfo) => void;
}) {
  const kind = KIND[p.kind] ?? { label: p.kind, tone: "" as Tone };
  const legacy = p.kind === "legacy";
  const cred = p.credential;
  const loginLabel = (t: ProviderAuthType) => {
    if (t === "oauth") return cred?.type === "oauth" ? "重新登录 (OAuth)" : "订阅登录 (OAuth)";
    return cred?.type === "api_key" ? "更换 API 密钥" : "配置 API 密钥";
  };
  return (
    <article className={`prov-tile ${p.configured ? "on" : ""}`}>
      <header className="prov-head">
        <div className="grow">
          <div className="prov-name serif">{p.name}</div>
          <div className="mono small muted ellipsis">{p.id}</div>
        </div>
        <div className="prov-tags">
          <Tag tone={kind.tone}>{kind.label}</Tag>
          {p.configured ? <Tag tone="jade">已启用</Tag> : <Tag outline>未配置</Tag>}
        </div>
      </header>

      <dl className="kv prov-kv">
        <dt>鉴权</dt>
        <dd>{p.configured ? <span className={isEnvSource(p.source) ? "" : "jade-ink"}>{sourceLabel(p.source)}</span> : <span className="muted">未配置</span>}</dd>
        {cred && (
          <>
            <dt>凭据</dt>
            <dd>
              {AUTH_LABEL[cred.type]}
              {cred.key_hint && <span className="mono"> {cred.key_hint}</span>}
              {cred.expires ? (
                <span className={`small ${cred.expires < Date.now() ? "bad-ink" : "muted"}`} title={fmtDateTime(cred.expires)}>
                  {" "}
                  · {cred.expires < Date.now() ? "已过期" : "到期"} {fmtAgo(cred.expires)}
                </span>
              ) : null}
            </dd>
          </>
        )}
        <dt>模型</dt>
        <dd>
          {p.model_count} 个{p.dynamic ? <span className="muted small"> · 登录后刷新目录</span> : null}
          {p.allow_unlisted ? <span className="muted small"> · 可用目录外 ID</span> : null}
        </dd>
        {p.apis.length > 0 && (
          <>
            <dt>接口</dt>
            <dd className="prov-codes">
              {p.apis.map((a) => (
                <code key={a}>{a}</code>
              ))}
            </dd>
          </>
        )}
        {p.base_url && (
          <>
            <dt>地址</dt>
            <dd className="mono small prov-url">{p.base_url}</dd>
          </>
        )}
        {p.header_names && p.header_names.length > 0 && (
          <>
            <dt>请求头</dt>
            <dd className="prov-codes">
              {p.header_names.map((h) => (
                <code key={h}>{h}</code>
              ))}
              <span className="muted small">（值不回传）</span>
            </dd>
          </>
        )}
        {!p.configured && p.env_vars && p.env_vars.length > 0 && (
          <>
            <dt>环境变量</dt>
            <dd className="prov-codes">
              {p.env_vars.map((v) => (
                <code key={v}>{v}</code>
              ))}
            </dd>
          </>
        )}
      </dl>

      {legacy ? (
        <div className="prov-foot">
          <span className="muted small grow">只读 · 在 config/models.yaml 中维护</span>
          <button className="btn sm" disabled={busy || !p.configured} onClick={() => onTest(p)}>
            测试
          </button>
          <button className="btn sm" onClick={() => onModels(p)}>
            模型
          </button>
        </div>
      ) : (
        <div className="prov-foot">
          {p.login_methods.length === 0 && !p.configured && <span className="muted small">仅能经环境变量配置</span>}
          {p.login_methods.map((t, i) => (
            <button key={t} className={`btn sm ${!p.configured && i === 0 ? "primary" : t === "oauth" ? "jade" : "gold"}`} disabled={busy} onClick={() => onLogin(p, t)}>
              {loginLabel(t)}
            </button>
          ))}
          <button className="btn sm" disabled={busy || !p.configured} title={p.configured ? "发一句话试其连通" : "尚未配置凭据"} onClick={() => onTest(p)}>
            测试
          </button>
          <button className="btn sm" onClick={() => onModels(p)}>
            模型
          </button>
          {p.kind === "custom" && (
            <>
              <button className="btn sm" disabled={busy} onClick={() => onEdit(p)}>
                编辑
              </button>
              <button className="btn sm danger" disabled={busy} onClick={() => onDelete(p)}>
                删除
              </button>
            </>
          )}
          {cred && (
            <button className="btn sm ghost danger" disabled={busy} onClick={() => onLogout(p)}>
              清除凭据
            </button>
          )}
        </div>
      )}
    </article>
  );
}

// ───────── 登录会话 ─────────
function LoginModal({ provider, initial, onClose, onDone }: { provider: ProviderInfo; initial: ProviderLoginSession; onClose: () => void; onDone: () => void }) {
  const [s, setS] = useState(initial);
  const [pollErr, setPollErr] = useState<unknown>(undefined);
  const [tick, setTick] = useState(0);
  const [sending, setSending] = useState(false);
  const toast = useToast();
  const active = s.state === "running" || s.state === "awaiting_input";
  const doneFired = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;

  // 轮询：进行中每秒；待输入时放缓（以察觉超时或外部取消）
  useEffect(() => {
    if (!active) return;
    let stop = false;
    const h = setTimeout(
      () => {
        hub
          .providerLogin(s.id)
          .then((n) => {
            if (stop) return;
            setPollErr(undefined);
            setS(n);
          })
          .catch((e) => {
            if (stop) return;
            setPollErr(e);
            setTick((t) => t + 1);
          });
      },
      s.state === "running" ? 1000 : 2500,
    );
    return () => {
      stop = true;
      clearTimeout(h);
    };
  }, [s, active, tick]);

  useEffect(() => {
    if (s.state === "done" && !doneFired.current) {
      doneFired.current = true;
      onDoneRef.current();
    }
  }, [s.state]);

  const cancel = async () => {
    try {
      setS(await hub.cancelProviderLogin(s.id));
    } catch (e) {
      toast(errorText(e), "bad");
    }
  };
  const close = () => {
    if (active) void hub.cancelProviderLogin(s.id).catch(() => undefined);
    onClose();
  };
  const answer = async (seq: number, value: string) => {
    setSending(true);
    try {
      setS(await hub.answerProviderLogin(s.id, seq, value));
    } catch (e) {
      toast(errorText(e), "bad");
    } finally {
      setSending(false);
    }
  };

  const st = SESSION_STATE[s.state] ?? { label: s.state, tone: "" as Tone };
  return (
    <Modal open onClose={close} title={`${provider.name} · ${AUTH_LABEL[s.type]}`} width={580}>
      <div className="row wrap" style={{ marginBottom: 10 }}>
        <Tag tone={st.tone}>
          {s.state === "running" && <span className="dot-state pulse" />}
          {st.label}
        </Tag>
        <span className="mono small muted">{provider.id}</span>
        <span className="muted small grow" style={{ textAlign: "right" }}>
          始于 {fmtAgo(s.started_at)}
        </span>
      </div>

      {s.events.length > 0 && (
        <ol className="login-events">
          {s.events.map((e, i) => (
            <LoginEventView key={`${e.at}-${i}`} e={e} last={i === s.events.length - 1 && s.state === "running"} />
          ))}
        </ol>
      )}
      {s.state === "running" && s.events.length === 0 && <Loading text="与提供商交涉中" />}

      {s.state === "awaiting_input" && s.prompt && <PromptForm key={s.prompt.seq} prompt={s.prompt} sending={sending} onSubmit={(v) => void answer(s.prompt!.seq, v)} />}

      {s.state === "done" && (
        <div className="login-final ok">
          <Seal text="准" tone="jade" size={26} stamp />
          <div>{s.type === "oauth" ? "登录成功，凭据已存入网关。" : "密钥已存入网关。"}可点「测试」验其连通。</div>
        </div>
      )}
      {s.state === "error" && (
        <div className="login-final bad">
          <Seal text="驳" tone="red" size={26} />
          <div>{s.error ?? "登录失败"}</div>
        </div>
      )}
      {s.state === "cancelled" && <div className="muted small">此次登录已中止。</div>}
      {pollErr !== undefined && active && <ErrorBox error={pollErr} />}

      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        {active ? (
          <>
            <button className="btn danger" onClick={() => void cancel()}>
              中止登录
            </button>
            <button className="btn" onClick={close}>
              罢
            </button>
          </>
        ) : (
          <button className="btn primary" onClick={onClose} autoFocus>
            {s.state === "done" ? "善" : "关闭"}
          </button>
        )}
      </div>
    </Modal>
  );
}

function LoginEventView({ e, last }: { e: ProviderLoginEvent; last: boolean }) {
  const links = e.links ?? [];
  if (e.type === "auth_url" && e.url) {
    return (
      <li className="login-ev box">
        <div className="serif">{e.message ?? "请在新窗口中完成授权"}</div>
        <a className="btn gold sm" href={e.url} target="_blank" rel="noopener noreferrer">
          打开授权页 ↗
        </a>
        <div className="mono small login-url">{e.url}</div>
        {e.instructions && <div className="small login-instr">{e.instructions}</div>}
        <LinkList links={links} />
      </li>
    );
  }
  if (e.type === "device_code") {
    return (
      <li className="login-ev box">
        <div className="serif">{e.message ?? "请在授权页输入下列验证码"}</div>
        {e.user_code && (
          <div className="device-code">
            <span className="mono">{e.user_code}</span>
            <CopyBtn text={e.user_code} />
          </div>
        )}
        {e.verification_uri && (
          <a className="btn gold sm" href={e.verification_uri} target="_blank" rel="noopener noreferrer">
            前往 {e.verification_uri} ↗
          </a>
        )}
        {e.instructions && <div className="small login-instr">{e.instructions}</div>}
        <LinkList links={links} />
      </li>
    );
  }
  return (
    <li className={`login-ev ${e.type}`}>
      <span className="muted small mono login-at">{fmtClock(e.at)}</span>
      <span className="grow">
        {e.message ?? e.instructions ?? e.type}
        {last && e.type === "progress" && <span className="brush-inline" />}
        <LinkList links={links} />
      </span>
    </li>
  );
}

function fmtClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

function LinkList({ links }: { links: { url: string; label?: string }[] }) {
  if (!links.length) return null;
  return (
    <div className="row wrap small">
      {links.map((l) => (
        <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer">
          {l.label ?? l.url} ↗
        </a>
      ))}
    </div>
  );
}

function CopyBtn({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      className="btn sm"
      onClick={() => {
        void navigator.clipboard
          ?.writeText(text)
          .then(() => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          })
          .catch(() => undefined);
      }}
    >
      {done ? "已抄" : "抄录"}
    </button>
  );
}

function PromptForm({ prompt, sending, onSubmit }: { prompt: NonNullable<ProviderLoginSession["prompt"]>; sending: boolean; onSubmit: (v: string) => void }) {
  const [v, setV] = useState(prompt.type === "select" ? (prompt.options?.[0]?.id ?? "") : "");
  const can = !sending && v.trim() !== "";
  const submit = () => can && onSubmit(prompt.type === "secret" ? v : v.trim());
  return (
    <form
      className="login-prompt"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="serif login-q">{prompt.message}</div>
      {prompt.type === "select" ? (
        <div className="login-options" role="radiogroup">
          {(prompt.options ?? []).map((o) => (
            <label key={o.id} className={`login-opt ${v === o.id ? "on" : ""}`}>
              <input type="radio" name={`opt-${prompt.seq}`} checked={v === o.id} onChange={() => setV(o.id)} />
              <span className="grow">
                <span className="serif">{o.label}</span>
                {o.description && <span className="muted small"> — {o.description}</span>}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <input
          type={prompt.type === "secret" ? "password" : "text"}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className={prompt.type === "text" ? "" : "mono"}
          placeholder={prompt.placeholder ?? (prompt.type === "manual_code" ? "粘贴授权码或回调地址" : prompt.type === "secret" ? "sk-…" : "")}
          value={v}
          onChange={(e) => setV(e.target.value)}
        />
      )}
      {prompt.type === "secret" && <div className="muted small">直送网关存储，不在浏览器留存。</div>}
      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 8 }}>
        <button type="submit" className="btn primary" disabled={!can}>
          {sending ? "呈递中…" : "呈上"}
        </button>
      </div>
    </form>
  );
}

// ───────── 测试 ─────────
function TestModal({ p, onClose }: { p: ProviderInfo; onClose: () => void }) {
  const models = useQuery(() => hub.providerModels(p.id), [p.id], { interval: 0 });
  const [mid, setMid] = useState("");
  const [res, setRes] = useState<ProviderTestRes | null>(null);
  const [err, setErr] = useState<unknown>(undefined);
  const [busy, setBusy] = useState(false);
  const picked = useRef(false);
  useEffect(() => {
    if (!picked.current && models.data && models.data.length > 0) {
      picked.current = true;
      setMid(models.data[0].id);
    }
  }, [models.data]);
  const go = async () => {
    setBusy(true);
    setRes(null);
    setErr(undefined);
    try {
      setRes(await hub.testProvider(p.id, mid.trim() || undefined));
    } catch (e) {
      setErr(e);
    } finally {
      setBusy(false);
    }
  };
  const listId = `test-models-${p.id}`;
  return (
    <Modal open onClose={onClose} title={`测试 · ${p.name}`} width={540}>
      <label className="field">
        <span className="label">模型 ID</span>
        <input type="text" list={listId} value={mid} onChange={(e) => setMid(e.target.value)} placeholder={models.initial ? "目录加载中…" : "留空由网关择默认模型"} className="mono" spellCheck={false} />
        <datalist id={listId}>
          {(models.data ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </datalist>
        <span className="hint">经网关发一句简短问候，计入账本（极少 token）。</span>
      </label>
      {models.error !== undefined && <ErrorBox error={models.error} onRetry={models.reload} />}
      {busy && <Loading text="候其回音" />}
      {res && (
        <div className={`test-res ${res.ok ? "ok" : "bad"}`}>
          <div className="row wrap">
            <Seal text={res.ok ? "通" : "阻"} tone={res.ok ? "jade" : "red"} size={24} stamp />
            <b className="serif">{res.ok ? "连通" : "不通"}</b>
            <span className="mono small">{res.model}</span>
            <span className="muted small">耗时 {fmtDuration(res.latency_ms)}</span>
          </div>
          {res.text && <div className="code-block test-text">{res.text}</div>}
          {res.error && <div className="small bad-ink test-text">{res.error}</div>}
        </div>
      )}
      {err !== undefined && <ErrorBox error={err} />}
      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 14 }}>
        <button className="btn" onClick={onClose}>
          罢
        </button>
        <button className="btn primary" disabled={busy} onClick={() => void go()}>
          试问
        </button>
      </div>
    </Modal>
  );
}

// ───────── 模型目录 ─────────
function ModelsDrawer({ p, onClose }: { p: ProviderInfo; onClose: () => void }) {
  const q = useQuery(() => hub.providerModels(p.id), [p.id], { interval: 0 });
  const pool = useQuery(() => hub.models(), [], { watch: ["model."], interval: 0 });
  const { run, pending } = useAction();
  const [k, setK] = useState("");
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const inPool = useMemo(() => new Set((pool.data ?? []).map((m) => m.key)), [pool.data]);
  const kk = k.trim().toLowerCase();
  const add = async (m: ProviderModelInfo) => {
    const r = await run(() => hub.addModel({ provider: p.id, model_id: m.id, name: m.name, context_window: m.context_window || undefined }), "已添入模型池，候考");
    if (r) {
      setAdded((s) => new Set(s).add(m.id));
      pool.reload();
    }
  };
  return (
    <Drawer open onClose={onClose} title={`模型目录 · ${p.name}`} width={820}>
      <div className="toolbar">
        <input type="search" placeholder="筛选模型" value={k} onChange={(e) => setK(e.target.value)} aria-label="筛选模型" />
        <span className="muted small grow">
          费用为每百万 token 美元价（入 / 出）
          {!p.configured && <span className="bad-ink"> · 此提供商尚未配置凭据，入池后无法应试</span>}
        </span>
        {added.size > 0 && (
          <Link className="btn sm gold" to="/exams" onClick={onClose}>
            前往科举 →
          </Link>
        )}
      </div>
      <QueryView q={q} empty={<Empty text={p.allow_unlisted ? "目录为空；可在科举页直接填写模型 ID" : "目录为空"} seal="空" />}>
        {(rows) => {
          const shown = kk ? rows.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(kk)) : rows;
          return shown.length === 0 ? (
            <Empty text="无匹配模型" seal="寻" />
          ) : (
            <div className="table-wrap">
              <table className="tbl models-tbl">
                <thead>
                  <tr>
                    <th>模型</th>
                    <th className="num">上下文</th>
                    <th className="num">最大输出</th>
                    <th>能力</th>
                    <th className="num">费用 /1M</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((m) => {
                    const key = `${p.id}/${m.id}`;
                    const has = inPool.has(key) || added.has(m.id);
                    return (
                      <tr key={m.id}>
                        <td>
                          <div className="serif">{m.name}</div>
                          <div className="mono small muted">{m.id}</div>
                        </td>
                        <td className="num">{fmtTokens(m.context_window)}</td>
                        <td className="num">{fmtTokens(m.max_tokens)}</td>
                        <td>
                          <div className="row wrap" style={{ gap: 4 }}>
                            {m.reasoning && <Tag tone="plum">推理</Tag>}
                            {m.input.includes("image") && <Tag tone="azure">识图</Tag>}
                            {!m.reasoning && !m.input.includes("image") && <span className="muted small">文本</span>}
                          </div>
                        </td>
                        <td className="num small nowrap">
                          {m.cost.input || m.cost.output ? (
                            <>
                              {fmtPerM(m.cost.input)} / {fmtPerM(m.cost.output)}
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {has ? (
                            <Link className="btn sm ghost" to="/exams" onClick={onClose} title={key}>
                              已在池 →
                            </Link>
                          ) : (
                            <button className="btn sm gold" disabled={pending} onClick={() => void add(m)}>
                              入池科举
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          );
        }}
      </QueryView>
    </Drawer>
  );
}

// ───────── 自定义提供商 ─────────
interface ModelRow {
  key: number;
  id: string;
  name: string;
  context_window: string;
  max_tokens: string;
  reasoning: boolean;
  image: boolean;
}
interface HeaderRow {
  key: number;
  name: string;
  value: string;
}
let rowSeq = 1;
const blankModel = (): ModelRow => ({ key: rowSeq++, id: "", name: "", context_window: "", max_tokens: "", reasoning: false, image: false });
const posInt = (s: string) => s.trim() === "" || (/^\d+$/.test(s.trim()) && Number(s) > 0);

function CustomProviderModal({ initial, all, onClose, onSaved }: { initial: ProviderInfo | null; all: ProviderInfo[]; onClose: () => void; onSaved: () => void }) {
  const editing = !!initial;
  const initialKeyless = !!initial?.keyless;
  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [api, setApi] = useState(initial?.apis[0] ?? "openai-completions");
  const [baseUrl, setBaseUrl] = useState(initial?.base_url ?? "");
  const [apiKey, setApiKey] = useState("");
  const [keyless, setKeyless] = useState(initialKeyless);
  const [allowUnlisted, setAllowUnlisted] = useState(initial?.allow_unlisted ?? true);
  const [models, setModels] = useState<ModelRow[]>(() => (editing ? [] : [blankModel()]));
  const [headers, setHeaders] = useState<HeaderRow[]>(() => (initial?.header_names ?? []).map((n) => ({ key: rowSeq++, name: n, value: "" })));
  const [headersTouched, setHeadersTouched] = useState(false);
  const { run, pending } = useAction();

  // 编辑时以现有目录预填模型
  const existing = useQuery(() => hub.providerModels(initial!.id), [initial?.id], { enabled: editing, interval: 0 });
  const filled = useRef(false);
  useEffect(() => {
    if (!editing || filled.current || !existing.data) return;
    filled.current = true;
    setModels(
      existing.data.map((m) => ({
        key: rowSeq++,
        id: m.id,
        name: m.name === m.id ? "" : m.name,
        context_window: m.context_window ? String(m.context_window) : "",
        max_tokens: m.max_tokens ? String(m.max_tokens) : "",
        reasoning: m.reasoning,
        image: m.input.includes("image"),
      })),
    );
  }, [editing, existing.data]);
  const modelsReady = !editing || filled.current;

  const setModel = (key: number, patch: Partial<ModelRow>) => setModels((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const setHeader = (key: number, patch: Partial<HeaderRow>) => {
    setHeadersTouched(true);
    setHeaders((xs) => xs.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  };

  // 校验
  const errors: string[] = [];
  const idT = id.trim();
  // 必填项为空时只禁用保存，不报错
  const missing = (!editing && !idT) || !baseUrl.trim();
  if (!editing && idT) {
    if (!ID_RE.test(idT)) errors.push("ID 只许小写字母、数字与 - _ .，且以字母或数字开头");
    else {
      const clash = all.find((p) => p.id === idT);
      if (clash) errors.push(clash.kind === "builtin" ? "ID 与内置提供商重名" : "此 ID 已存在");
    }
  }
  if (baseUrl.trim() && !URL_RE.test(baseUrl.trim())) errors.push("Base URL 须以 http:// 或 https:// 开头");
  const usedModels = models.filter((m) => m.id.trim() || m.name.trim() || m.context_window.trim() || m.max_tokens.trim());
  const ids = usedModels.map((m) => m.id.trim());
  if (usedModels.some((m) => !m.id.trim())) errors.push("模型须填 ID（或删去空行）");
  if (new Set(ids).size !== ids.length) errors.push("模型 ID 重复");
  if (usedModels.some((m) => !posInt(m.context_window) || !posInt(m.max_tokens))) errors.push("上下文与最大输出须为正整数");
  if (!allowUnlisted && usedModels.length === 0) errors.push("未列模型又不许目录外 ID，则无模型可用");
  if (headersTouched) {
    const named = headers.filter((h) => h.name.trim() || h.value);
    if (named.some((h) => !HEADER_RE.test(h.name.trim()))) errors.push("请求头名不合法");
    if (named.some((h) => !h.value)) errors.push("请求头须逐一填写值");
    const hn = named.map((h) => h.name.trim().toLowerCase());
    if (new Set(hn).size !== hn.length) errors.push("请求头重名");
  }
  const canSave = !pending && modelsReady && !missing && errors.length === 0;

  const save = async () => {
    const spec: CustomProviderSpec = {
      id: editing ? initial!.id : idT,
      name: name.trim() || undefined,
      api,
      base_url: baseUrl.trim(),
      allow_unlisted: allowUnlisted,
      models: usedModels.map((m) => ({
        id: m.id.trim(),
        name: m.name.trim() || undefined,
        context_window: m.context_window.trim() ? Number(m.context_window) : undefined,
        max_tokens: m.max_tokens.trim() ? Number(m.max_tokens) : undefined,
        reasoning: m.reasoning || undefined,
        input: m.image ? ["text", "image"] : ["text"],
      })),
    };
    if (!keyless && apiKey.trim()) spec.api_key = apiKey.trim();
    if (keyless || keyless !== initialKeyless) spec.keyless = keyless;
    if (headersTouched || (!editing && headers.length > 0)) {
      spec.headers = Object.fromEntries(headers.filter((h) => h.name.trim()).map((h) => [h.name.trim(), h.value]));
    }
    const r = await run(() => hub.saveCustomProvider(spec), editing ? "已改定" : "已新增自定义提供商");
    if (r) {
      onSaved();
      onClose();
    }
  };

  return (
    <Drawer open onClose={onClose} title={editing ? `编辑 · ${initial!.name}` : "新增自定义提供商"} width={720}>
      <div className="grid g2" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">ID</span>
          <input type="text" className="mono" value={id} disabled={editing} onChange={(e) => setId(e.target.value)} placeholder="my-vllm" spellCheck={false} />
          <span className="hint">{editing ? "ID 不可改；模型键为 ID/模型 ID" : "小写字母数字与 - _ .；模型键为 ID/模型 ID"}</span>
        </label>
        <label className="field">
          <span className="label">名称</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="显示名（可空）" />
        </label>
        <label className="field">
          <span className="label">接口 API</span>
          <select value={api} onChange={(e) => setApi(e.target.value)}>
            {API_OPTIONS.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
            {!API_OPTIONS.some((o) => o.id === api) && <option value={api}>{api}</option>}
          </select>
        </label>
        <label className="field">
          <span className="label">Base URL</span>
          <input type="url" className="mono" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" spellCheck={false} />
        </label>
      </div>

      <label className="field">
        <span className="label">API 密钥（只写）</span>
        <input
          type="password"
          className="mono"
          autoComplete="new-password"
          value={apiKey}
          disabled={keyless}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={keyless ? "无需鉴权" : editing ? "留空则不修改" : "sk-…（可留空，稍后再配置）"}
        />
        {editing && initial?.credential?.key_hint && !keyless && <span className="hint">现存密钥 {initial.credential.key_hint}</span>}
      </label>
      <div className="row wrap" style={{ gap: 18, marginBottom: 12 }}>
        <label className="row">
          <input type="checkbox" checked={keyless} onChange={(e) => setKeyless(e.target.checked)} /> 无需鉴权（本地 Ollama / vLLM 等）
        </label>
        <label className="row">
          <input type="checkbox" checked={allowUnlisted} onChange={(e) => setAllowUnlisted(e.target.checked)} /> 允许目录外模型 ID
        </label>
      </div>

      <section className="set-sub">
        <div className="row between">
          <h3>模型目录</h3>
          <button className="btn sm" onClick={() => setModels((xs) => [...xs, blankModel()])}>
            ＋ 添一行
          </button>
        </div>
        {editing && !modelsReady ? (
          existing.error !== undefined ? <ErrorBox error={existing.error} onRetry={existing.reload} /> : <Loading text="读取现有目录" />
        ) : models.length === 0 ? (
          <div className="muted small">{allowUnlisted ? "未列模型：科举页可直接填写任意模型 ID。" : "请至少列一个模型。"}</div>
        ) : (
          <div className="col">
            {models.map((m) => (
              <div key={m.key} className="mrow">
                <label className="field">
                  <span className="label">模型 ID</span>
                  <input type="text" className="mono" value={m.id} onChange={(e) => setModel(m.key, { id: e.target.value })} placeholder="qwen3-32b" spellCheck={false} />
                </label>
                <label className="field">
                  <span className="label">名称</span>
                  <input type="text" value={m.name} onChange={(e) => setModel(m.key, { name: e.target.value })} placeholder="可空" />
                </label>
                <label className="field">
                  <span className="label">上下文</span>
                  <input type="number" min={1} value={m.context_window} onChange={(e) => setModel(m.key, { context_window: e.target.value })} placeholder="128000" />
                </label>
                <label className="field">
                  <span className="label">最大输出</span>
                  <input type="number" min={1} value={m.max_tokens} onChange={(e) => setModel(m.key, { max_tokens: e.target.value })} placeholder="8192" />
                </label>
                <div className="mrow-flags">
                  <label className="row small">
                    <input type="checkbox" checked={m.reasoning} onChange={(e) => setModel(m.key, { reasoning: e.target.checked })} /> 推理
                  </label>
                  <label className="row small">
                    <input type="checkbox" checked={m.image} onChange={(e) => setModel(m.key, { image: e.target.checked })} /> 识图
                  </label>
                  <button className="btn sm ghost danger" onClick={() => setModels((xs) => xs.filter((x) => x.key !== m.key))} aria-label="删去此行">
                    删
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="set-sub">
        <div className="row between">
          <h3>额外请求头</h3>
          <button
            className="btn sm"
            onClick={() => {
              setHeadersTouched(true);
              setHeaders((xs) => [...xs, { key: rowSeq++, name: "", value: "" }]);
            }}
          >
            ＋ 添一项
          </button>
        </div>
        {editing && (initial?.header_names?.length ?? 0) > 0 && (
          <div className={`small ${headersTouched ? "warn-ink" : "muted"}`} style={{ marginBottom: 6 }}>
            {headersTouched ? "请求头已改动：保存时整组替换，须重新填写每一项的值。" : "请求头的值视同密钥、不回传；不动则原样保留。若改动，须重新填写全部值。"}
          </div>
        )}
        {headers.length === 0 ? (
          <div className="muted small">无</div>
        ) : (
          <div className="col">
            {headers.map((h) => (
              <div key={h.key} className="hrow">
                <input type="text" className="mono" value={h.name} onChange={(e) => setHeader(h.key, { name: e.target.value })} placeholder="X-Api-Version" aria-label="请求头名" spellCheck={false} />
                <input
                  type="password"
                  className="mono"
                  autoComplete="new-password"
                  value={h.value}
                  onChange={(e) => setHeader(h.key, { value: e.target.value })}
                  placeholder={editing && !headersTouched ? "（已存，值不回传）" : "值"}
                  aria-label="请求头值"
                />
                <button
                  className="btn sm ghost danger"
                  onClick={() => {
                    setHeadersTouched(true);
                    setHeaders((xs) => xs.filter((x) => x.key !== h.key));
                  }}
                  aria-label="删去此项"
                >
                  删
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {errors.length > 0 && (
        <ul className="set-errs small">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="btn-row" style={{ justifyContent: "flex-end", marginTop: 16 }}>
        <button className="btn" onClick={onClose}>
          且慢
        </button>
        <button className="btn primary" disabled={!canSave} onClick={() => void save()}>
          {editing ? "改定" : "新增"}
        </button>
      </div>
    </Drawer>
  );
}
