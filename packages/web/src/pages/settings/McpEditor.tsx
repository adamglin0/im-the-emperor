// MCP 服务器编辑抽屉：连接（HTTP / stdio 容器）、高级（超时、工具白名单）、授权对象；草稿可先测试再保存。
// 密钥（请求头 / 环境变量的值）只写不读：已存的键显示「已设置·留空沿用」，提交时值为 null 即沿用；删去的键不提交即删除。
import { useMemo, useState } from "react";
import {
  MCP_DEFAULT_IMAGE,
  MCP_ENV_KEY_RE,
  MCP_HEADER_KEY_RE,
  MCP_ID_RE,
  MCP_IMAGE_PRESETS,
  MCP_LIMITS,
  mcpTargetKey,
  type McpNetwork,
  type McpServerInput,
  type McpServerView,
  type McpTarget,
  type McpTestRes,
  type McpTransport,
} from "@court/shared/mcp";
import { hub, slowHub } from "../../api/client.ts";
import { useRegistry } from "../../api/registry.tsx";
import { Drawer } from "../../components/Overlay.tsx";
import { PostPicker } from "../../components/PostPicker.tsx";
import { ErrorBox, Loading } from "../../components/States.tsx";
import { Seg } from "../../components/Tabs.tsx";
import { useToast } from "../../components/Toast.tsx";
import { useAction } from "../../hooks/useAction.ts";
import { TargetChip, TestResult, mcpErrText, useTargetView } from "./mcpUi.tsx";

interface SecretRow {
  key: number;
  name: string;
  value: string;
  /** 已存于 hub 的键：值不回传，留空 = 沿用 */
  stored: boolean;
}
let rowSeq = 1;
const IMAGE_RE = /^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,254}$/;
const URL_RE = /^https?:\/\/\S+$/i;

const storedRows = (keys: string[]): SecretRow[] => keys.map((k) => ({ key: rowSeq++, name: k, value: "", stored: true }));
const rowsToInput = (rows: SecretRow[]): Record<string, string | null> =>
  Object.fromEntries(rows.filter((r) => r.name.trim()).map((r) => [r.name.trim(), r.stored && r.value === "" ? null : r.value]));

function validateRows(rows: SecretRow[], what: string, keyRe: RegExp, max: number, caseless: boolean, errors: string[]) {
  const used = rows.filter((r) => r.stored || r.name.trim() || r.value);
  if (used.length > max) errors.push(`${what}至多 ${max} 项`);
  if (used.some((r) => !keyRe.test(r.name.trim()))) errors.push(`${what}名不合法`);
  if (used.some((r) => !r.stored && !r.value)) errors.push(`新增的${what}须填写值`);
  const names = used.map((r) => (caseless ? r.name.trim().toLowerCase() : r.name.trim()));
  if (new Set(names).size !== names.length) errors.push(`${what}重名`);
}

function numIn(s: string, min: number, max: number, int: boolean): boolean {
  const t = s.trim();
  if (!t) return true;
  const n = Number(t);
  return Number.isFinite(n) && n >= min && n <= max && (!int || Number.isInteger(n));
}

export function McpEditor({ initial, all, onClose, onSaved }: { initial: McpServerView | null; all: McpServerView[]; onClose: () => void; onSaved: () => void }) {
  const editing = !!initial;
  const r = useRegistry();
  const tv = useTargetView();
  const toast = useToast();
  const { run, pending } = useAction();

  const [id, setId] = useState(initial?.id ?? "");
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [transport, setTransport] = useState<McpTransport>(initial?.transport ?? "streamable_http");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  // HTTP
  const [url, setUrl] = useState(initial?.url ?? "");
  const [headers, setHeaders] = useState<SecretRow[]>(() => storedRows(initial?.header_keys ?? []));
  // stdio
  const [image, setImage] = useState(initial?.image ?? MCP_DEFAULT_IMAGE);
  const [command, setCommand] = useState(initial?.command ?? "");
  const [argsText, setArgsText] = useState((initial?.args ?? []).join("\n"));
  const [env, setEnv] = useState<SecretRow[]>(() => storedRows(initial?.env_keys ?? []));
  const [network, setNetwork] = useState<McpNetwork>(initial?.network ?? "bridge");
  const [memory, setMemory] = useState(initial?.memory_mb !== undefined ? String(initial.memory_mb) : "");
  const [cpus, setCpus] = useState(initial?.cpus !== undefined ? String(initial.cpus) : "");
  // 高级
  const [timeout, setTimeoutS] = useState(initial?.timeout_seconds !== undefined ? String(initial.timeout_seconds) : "");
  const [toolAllow, setToolAllow] = useState<string[]>(initial?.tool_allow ?? []);
  const [toolInput, setToolInput] = useState("");
  // 授权
  const [targets, setTargets] = useState<McpTarget[]>(initial?.targets ?? []);
  // 草稿测试
  const [testRes, setTestRes] = useState<McpTestRes | null>(null);
  const [testErr, setTestErr] = useState<unknown>(undefined);
  const [testing, setTesting] = useState(false);

  const preset = MCP_IMAGE_PRESETS.find((p) => p.image === image.trim());
  const hint = preset ?? MCP_IMAGE_PRESETS[0];
  const args = argsText.split("\n").map((a) => a.trim()).filter(Boolean);
  const targetKeys = useMemo(() => new Set(targets.map(mcpTargetKey)), [targets]);
  const hasAll = targetKeys.has("all");

  // ── 校验（必填项为空只禁用保存，不报错）
  const errors: string[] = [];
  const idT = id.trim();
  const missing = (!editing && !idT) || !name.trim() || (transport === "streamable_http" ? !url.trim() : !command.trim());
  if (!editing && idT) {
    if (!MCP_ID_RE.test(idT)) errors.push("ID 须以小写字母开头，仅含小写字母、数字、- 与 _，共 2–24 字");
    else if (all.some((s) => s.id === idT)) errors.push("此 ID 已存在");
  }
  if (name.trim().length > 60) errors.push("名称至多 60 字");
  if (description.length > 500) errors.push("说明至多 500 字");
  if (transport === "streamable_http") {
    if (url.trim() && !URL_RE.test(url.trim())) errors.push("URL 须以 http:// 或 https:// 开头");
    validateRows(headers, "请求头", MCP_HEADER_KEY_RE, MCP_LIMITS.maxHeaders, true, errors);
  } else {
    if (image.trim() && !IMAGE_RE.test(image.trim())) errors.push("镜像名不合法");
    if (args.length > MCP_LIMITS.maxArgs) errors.push(`参数至多 ${MCP_LIMITS.maxArgs} 个`);
    if (args.some((a) => a.length > 4096)) errors.push("单个参数至多 4096 字");
    validateRows(env, "环境变量", MCP_ENV_KEY_RE, MCP_LIMITS.maxEnv, false, errors);
    if (!numIn(memory, 64, MCP_LIMITS.maxMemoryMb, true)) errors.push(`内存须为 64–${MCP_LIMITS.maxMemoryMb} 的整数（MB）`);
    if (!numIn(cpus, 0.1, MCP_LIMITS.maxCpus, false)) errors.push(`CPU 须在 0.1–${MCP_LIMITS.maxCpus} 之间`);
  }
  if (!numIn(timeout, 1, MCP_LIMITS.maxTimeoutSeconds, true)) errors.push(`超时须为 1–${MCP_LIMITS.maxTimeoutSeconds} 的整数（秒）`);
  if (toolAllow.length > MCP_LIMITS.maxToolAllow) errors.push(`工具白名单至多 ${MCP_LIMITS.maxToolAllow} 项`);
  if (targets.length > MCP_LIMITS.maxTargets) errors.push(`授权对象至多 ${MCP_LIMITS.maxTargets} 个`);
  const ready = !missing && errors.length === 0;

  const buildInput = (): McpServerInput => {
    const base: McpServerInput = {
      name: name.trim(),
      description: description.trim(),
      transport,
      enabled,
      targets,
      tool_allow: toolAllow,
      timeout_seconds: timeout.trim() ? Number(timeout) : MCP_LIMITS.defaultTimeoutSeconds,
    };
    if (!editing) base.id = idT;
    if (transport === "streamable_http") return { ...base, url: url.trim(), headers: rowsToInput(headers) };
    return {
      ...base,
      image: image.trim() || MCP_DEFAULT_IMAGE,
      command: command.trim(),
      args,
      env: rowsToInput(env),
      network,
      memory_mb: memory.trim() ? Number(memory) : MCP_LIMITS.defaultMemoryMb,
      cpus: cpus.trim() ? Number(cpus) : MCP_LIMITS.defaultCpus,
    };
  };

  const test = async () => {
    setTesting(true);
    setTestRes(null);
    setTestErr(undefined);
    try {
      setTestRes(await slowHub.testMcpDraft({ base_id: initial?.id, server: buildInput() }));
    } catch (e) {
      setTestErr(e);
    } finally {
      setTesting(false);
    }
  };

  const save = async () => {
    const input = buildInput();
    const res = await run(() => (editing ? hub.updateMcpServer(initial!.id, { ...input, expected_version: initial!.version }) : hub.createMcpServer(input)));
    if (!res) return;
    if (res.status === "pending_approval") toast("已呈待批", "info");
    else toast(editing ? "已改定" : "已接入", "ok");
    onSaved();
    onClose();
  };

  // ── 授权对象
  const toggleTarget = (t: McpTarget, on: boolean) => {
    const k = mcpTargetKey(t);
    setTargets((xs) => (on ? (xs.some((x) => mcpTargetKey(x) === k) ? xs : [...xs, t]) : xs.filter((x) => mcpTargetKey(x) !== k)));
  };
  const addOfficialByPost = (post: string) => {
    const o = r.officialOf(post);
    if (!o) {
      toast(`${r.postLabel(post, false)} 空缺，无人可授`, "bad");
      return;
    }
    if (targetKeys.has(`official:${o.official_id}`)) {
      toast(`${o.name} 已在授权之列`, "info");
      return;
    }
    toggleTarget({ kind: "official", id: o.official_id }, true);
  };
  const officials = targets.filter((t) => t.kind === "official");

  // ── 工具白名单
  const addTool = (raw: string) => {
    const names = raw.split(/[\s,，]+/).map((x) => x.trim()).filter(Boolean);
    if (names.length) setToolAllow((xs) => [...xs, ...names.filter((n) => !xs.includes(n))]);
    setToolInput("");
  };
  const discovered = testRes?.ok ? testRes.tools : [];

  return (
    <Drawer open onClose={onClose} title={editing ? `编辑 · ${initial!.name}` : "接入 MCP 服务器"} width={760}>
      <div className="grid g2" style={{ gap: 12 }}>
        <label className="field">
          <span className="label">ID</span>
          <input type="text" className="mono" value={id} disabled={editing} onChange={(e) => setId(e.target.value.toLowerCase())} placeholder="github" spellCheck={false} maxLength={24} />
          <span className="hint">{editing ? "ID 不可改；官员工具名为 mcp__ID__工具" : "小写字母开头，2–24 字；作官员工具名前缀"}</span>
        </label>
        <label className="field">
          <span className="label">名称</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="GitHub" maxLength={60} />
          <span className="hint">工具说明中以「MCP·名称」标注</span>
        </label>
      </div>
      <label className="field">
        <span className="label">说明</span>
        <textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="此服务器能做什么（官员可见）" maxLength={500} style={{ minHeight: 52 }} />
      </label>
      <div className="row wrap" style={{ gap: 16, marginBottom: 12 }}>
        <span className="label small muted">传输</span>
        <Seg<McpTransport>
          options={[
            { key: "streamable_http", label: "Streamable HTTP" },
            { key: "stdio", label: "stdio（独立容器）" },
          ]}
          value={transport}
          onChange={setTransport}
        />
        <label className="mcp-switch">
          <input type="checkbox" role="switch" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          <span className="mcp-switch-track" aria-hidden />
          <span className="small">{enabled ? "启用" : "停用"}</span>
        </label>
      </div>
      {editing && transport !== initial!.transport && <div className="small warn-ink" style={{ marginBottom: 8 }}>切换传输方式后，原有{initial!.transport === "stdio" ? "镜像、命令与环境变量" : "地址与请求头"}将被清除。</div>}

      {transport === "streamable_http" ? (
        <section className="set-sub">
          <h3>连接 · HTTP</h3>
          <label className="field">
            <span className="label">URL</span>
            <input type="url" className="mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.example.com/mcp" spellCheck={false} />
            <span className="hint">须从 MCP 中转站容器可达；朝廷内部主机（hub、网关、各部门）一律拒连。</span>
          </label>
          <SecretRows rows={headers} setRows={setHeaders} what="请求头" namePh="Authorization" valuePh="Bearer …" max={MCP_LIMITS.maxHeaders} />
        </section>
      ) : (
        <section className="set-sub">
          <h3>连接 · stdio 容器</h3>
          <div className="grid g2" style={{ gap: 12 }}>
            <label className="field">
              <span className="label">镜像</span>
              <div className="mcp-image">
                <select
                  value={preset ? preset.image : ""}
                  aria-label="镜像预设"
                  onChange={(e) => {
                    const p = MCP_IMAGE_PRESETS.find((x) => x.image === e.target.value);
                    if (!p) return;
                    setImage(p.image);
                    if (!command.trim()) setCommand(p.command);
                  }}
                >
                  {MCP_IMAGE_PRESETS.map((p) => (
                    <option key={p.image} value={p.image}>
                      {p.label}
                    </option>
                  ))}
                  <option value="">自定义镜像</option>
                </select>
                <input type="text" className="mono" value={image} onChange={(e) => setImage(e.target.value)} placeholder={MCP_DEFAULT_IMAGE} spellCheck={false} aria-label="镜像名" />
              </div>
            </label>
            <label className="field">
              <span className="label">命令</span>
              <input type="text" className="mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder={hint.command} spellCheck={false} />
              <span className="hint">在容器内执行，经 stdin/stdout 说 MCP</span>
            </label>
          </div>
          <label className="field">
            <span className="label">参数（每行一个）</span>
            <textarea className="mono" rows={3} value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder={hint.args.join("\n")} spellCheck={false} />
          </label>
          <div className="grid g3" style={{ gap: 12 }}>
            <label className="field">
              <span className="label">网络</span>
              <select value={network} onChange={(e) => setNetwork(e.target.value as McpNetwork)}>
                <option value="bridge">bridge · 可联网</option>
                <option value="none">none · 断网</option>
              </select>
              <span className="hint">npx / uvx 首次运行须联网下载</span>
            </label>
            <label className="field">
              <span className="label">内存（MB）</span>
              <input type="number" min={64} max={MCP_LIMITS.maxMemoryMb} step={64} value={memory} onChange={(e) => setMemory(e.target.value)} placeholder={String(MCP_LIMITS.defaultMemoryMb)} />
            </label>
            <label className="field">
              <span className="label">CPU</span>
              <input type="number" min={0.1} max={MCP_LIMITS.maxCpus} step={0.5} value={cpus} onChange={(e) => setCpus(e.target.value)} placeholder={String(MCP_LIMITS.defaultCpus)} />
            </label>
          </div>
          <SecretRows rows={env} setRows={setEnv} what="环境变量" namePh="GITHUB_TOKEN" valuePh="值" max={MCP_LIMITS.maxEnv} />
        </section>
      )}

      <section className="set-sub">
        <h3>授权对象</h3>
        <label className="row" style={{ marginBottom: 10 }}>
          <input type="checkbox" checked={hasAll} onChange={(e) => toggleTarget({ kind: "all" }, e.target.checked)} />
          <b className="serif">所有人</b>
          <span className="muted small">满朝官员皆可用{hasAll && targets.length > 1 ? "（其余授权已被涵盖）" : ""}</span>
        </label>
        <div className="label small muted" style={{ marginBottom: 6 }}>
          部门
        </div>
        <div className="mcp-check-grid">
          {r.depts.map((d) => {
            const on = targetKeys.has(`dept:${d.id}`);
            return (
              <label key={d.id} className={`mcp-check ${on ? "on" : ""}`} title={d.brief}>
                <input type="checkbox" checked={on} onChange={(e) => toggleTarget({ kind: "dept", id: d.id }, e.target.checked)} />
                <span className="ellipsis">{d.name}</span>
              </label>
            );
          })}
          {targets
            .filter((t) => t.kind === "dept" && !r.dept(t.id))
            .map((t) => (
              <TargetChip key={mcpTargetKey(t)} v={tv(t)} onRemove={() => toggleTarget(t, false)} />
            ))}
        </div>
        <div className="label small muted" style={{ margin: "12px 0 6px" }}>
          官员（跟人走：调岗后仍有效）
        </div>
        <PostPicker value="" mode="post" onChange={addOfficialByPost} placeholder="搜索职位或官员，选中即添入…" />
        {officials.length > 0 && (
          <div className="mcp-targets" style={{ marginTop: 8 }}>
            {officials.map((t) => (
              <TargetChip key={mcpTargetKey(t)} v={tv(t)} onRemove={() => toggleTarget(t, false)} />
            ))}
          </div>
        )}
        {targets.length === 0 && <div className="small warn-ink" style={{ marginTop: 8 }}>尚未授权任何人：保存后无人可用其工具。</div>}
      </section>

      <section className="set-sub">
        <h3>高级</h3>
        <div className="grid g2" style={{ gap: 12 }}>
          <label className="field">
            <span className="label">单次调用超时（秒）</span>
            <input type="number" min={1} max={MCP_LIMITS.maxTimeoutSeconds} value={timeout} onChange={(e) => setTimeoutS(e.target.value)} placeholder={String(MCP_LIMITS.defaultTimeoutSeconds)} />
          </label>
          <label className="field">
            <span className="label">工具白名单</span>
            <div className="mcp-image">
              <input
                type="text"
                className="mono"
                value={toolInput}
                onChange={(e) => setToolInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTool(toolInput);
                  }
                }}
                placeholder="工具原名，回车添入"
                spellCheck={false}
              />
              <button type="button" className="btn sm" disabled={!toolInput.trim()} onClick={() => addTool(toolInput)}>
                添入
              </button>
            </div>
            <span className="hint">留空即全部开放（每位官员每服务器至多 {MCP_LIMITS.maxToolsPerServer} 个）</span>
          </label>
        </div>
        {toolAllow.length > 0 && (
          <div className="mcp-targets" style={{ marginBottom: 8 }}>
            {toolAllow.map((t) => (
              <span key={t} className="mcp-target tool">
                <code>{t}</code>
                <button type="button" className="mcp-target-x" onClick={() => setToolAllow((xs) => xs.filter((x) => x !== t))} aria-label={`移除 ${t}`}>
                  ✕
                </button>
              </span>
            ))}
            <button type="button" className="btn sm ghost" onClick={() => setToolAllow([])}>
              清空
            </button>
          </div>
        )}
        {discovered.length > 0 && (
          <div className="mcp-discovered">
            <div className="row between small" style={{ marginBottom: 6 }}>
              <span className="muted">测试发现 {discovered.length} 个工具 · 勾选即只开放所勾者</span>
              <span className="row" style={{ gap: 4 }}>
                <button type="button" className="btn sm ghost" onClick={() => setToolAllow(discovered.map((t) => t.name))}>
                  全选
                </button>
                <button type="button" className="btn sm ghost" onClick={() => setToolAllow([])}>
                  不限
                </button>
              </span>
            </div>
            <div className="mcp-check-grid">
              {discovered.map((t) => {
                const on = toolAllow.includes(t.name);
                return (
                  <label key={t.name} className={`mcp-check ${on ? "on" : ""}`} title={t.description}>
                    <input type="checkbox" checked={on} onChange={(e) => setToolAllow((xs) => (e.target.checked ? [...xs, t.name] : xs.filter((x) => x !== t.name)))} />
                    <span className="mono ellipsis">{t.name}</span>
                  </label>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {(testing || testRes || testErr !== undefined) && (
        <section className="set-sub">
          <h3>测试结果</h3>
          {testing && <Loading text={transport === "stdio" ? "以草稿临时连接中（stdio 首次启动要拉镜像、下载包，可能需 1–3 分钟）" : "以草稿临时连接中"} />}
          {testRes && <TestResult res={testRes} />}
          {testErr !== undefined && <ErrorBox error={new Error(mcpErrText(testErr))} />}
        </section>
      )}

      {errors.length > 0 && (
        <ul className="set-errs small">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="btn-row mcp-foot">
        <span className="muted small grow">{editing ? `修订 v${initial!.version}；保存时若他人已改则拒收` : "测试不保存；密钥仅送皇城"}</span>
        <button className="btn" onClick={onClose}>
          且慢
        </button>
        <button className="btn gold" disabled={!ready || testing} onClick={() => void test()} title="以当前草稿临时连接、列出工具，不保存">
          {testing ? "测试中…" : "测试连接"}
        </button>
        <button className="btn primary" disabled={!ready || pending} onClick={() => void save()}>
          {editing ? "改定" : "接入"}
        </button>
      </div>
    </Drawer>
  );
}

function SecretRows({ rows, setRows, what, namePh, valuePh, max }: { rows: SecretRow[]; setRows: (f: (xs: SecretRow[]) => SecretRow[]) => void; what: string; namePh: string; valuePh: string; max: number }) {
  const patch = (key: number, p: Partial<SecretRow>) => setRows((xs) => xs.map((x) => (x.key === key ? { ...x, ...p } : x)));
  return (
    <div style={{ marginTop: 4 }}>
      <div className="row between" style={{ marginBottom: 6 }}>
        <span className="label small muted">
          {what}
          <span className="muted">（值只写不读）</span>
        </span>
        <button type="button" className="btn sm" disabled={rows.length >= max} onClick={() => setRows((xs) => [...xs, { key: rowSeq++, name: "", value: "", stored: false }])}>
          ＋ 添一项
        </button>
      </div>
      {rows.length === 0 ? (
        <div className="muted small">无</div>
      ) : (
        <div className="col">
          {rows.map((h) => (
            <div key={h.key} className="hrow">
              <input type="text" className="mono" value={h.name} disabled={h.stored} title={h.stored ? "已存的键不可改名；如需改名，删去后另添" : undefined} onChange={(e) => patch(h.key, { name: e.target.value })} placeholder={namePh} aria-label={`${what}名`} spellCheck={false} />
              <input
                type="password"
                className="mono"
                autoComplete="new-password"
                value={h.value}
                onChange={(e) => patch(h.key, { value: e.target.value })}
                placeholder={h.stored ? "已设置 · 留空沿用" : valuePh}
                aria-label={`${what}值`}
              />
              <button type="button" className="btn sm ghost danger" onClick={() => setRows((xs) => xs.filter((x) => x.key !== h.key))} aria-label="删去此项">
                删
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
