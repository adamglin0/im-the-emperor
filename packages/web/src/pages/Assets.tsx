// 资产库：按所有者成树（朝廷公开 / 各部门 → 部门资产 + 官员私产），预览、版本与 diff
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import type { Asset } from "@court/shared/types";
import { hub } from "../api/client.ts";
import { useRegistry } from "../api/registry.tsx";
import { Addr, TimeAgo, TraceLink } from "../components/Addr.tsx";
import { Card, PageHead } from "../components/Card.tsx";
import { DiffView } from "../components/DiffView.tsx";
import { JsonView } from "../components/JsonView.tsx";
import { Markdown } from "../components/Markdown.tsx";
import { Empty, ErrorBox, Loading, QueryView } from "../components/States.tsx";
import { Tag } from "../components/Tag.tsx";
import { useQuery } from "../hooks/useQuery.ts";
import { fmtBytes, fmtDateTime } from "../lib/format.ts";
import { DEPT_SEAL, VISIBILITY } from "../lib/labels.ts";
import "../styles/pages/ops.css";

type Node = { kind: "all" } | { kind: "court" } | { kind: "dept"; id: string } | { kind: "deptOnly"; id: string } | { kind: "post"; id: string };

function nodeKey(n: Node): string {
  return n.kind === "all" || n.kind === "court" ? n.kind : `${n.kind}:${n.id}`;
}
function deptOf(owner: string): string | undefined {
  const [k, id] = owner.split(":");
  if (k === "dept") return id;
  if (k === "post") return id?.split(".")[0];
  return undefined;
}
function matchNode(a: Asset, n: Node): boolean {
  switch (n.kind) {
    case "all":
      return true;
    case "court":
      return a.owner === "court";
    case "dept":
      return deptOf(a.owner) === n.id;
    case "deptOnly":
      return a.owner === `dept:${n.id}`;
    case "post":
      return a.owner === `post:${n.id}`;
  }
}

function VisBadge({ a }: { a: Asset }) {
  const v = a.shared_with.length > 0 && a.visibility !== "court" ? VISIBILITY.shared : VISIBILITY[a.visibility];
  return (
    <span className={`vis-badge ${v.tone}`} title={a.shared_with.length ? `共享给 ${a.shared_with.join("、")}` : undefined}>
      {v.label}
    </span>
  );
}

type Kind = "markdown" | "json" | "code" | "image" | "binary" | "text";
const CODE_EXT = /\.(py|ts|tsx|js|mjs|cjs|sh|bash|rs|go|java|kt|c|cc|cpp|h|rb|php|sql|yaml|yml|toml|css|html|xml|ini|cfg)$/i;
function kindOf(mime: string, path: string, encoding: "utf8" | "base64"): Kind {
  if (mime.startsWith("image/") && encoding === "base64") return "image";
  if (encoding === "base64") return "binary";
  if (mime === "text/markdown" || /\.(md|markdown)$/i.test(path)) return "markdown";
  if (mime.includes("json") || /\.json$/i.test(path)) return "json";
  if (mime.startsWith("text/x-") || /javascript|typescript|yaml|xml|x-sh/.test(mime) || CODE_EXT.test(path)) return "code";
  return "text";
}
const KIND_LABEL: Record<Kind, string> = { markdown: "文", json: "数", code: "码", image: "图", binary: "器", text: "文" };

export default function AssetsPage() {
  const r = useRegistry();
  const [params, setParams] = useSearchParams();
  const selectedId = params.get("id") ?? "";
  const [q, setQ] = useState("");
  const [node, setNode] = useState<Node>({ kind: "all" });
  const [openDepts, setOpenDepts] = useState<Record<string, boolean>>({});
  const list = useQuery(() => hub.assets({ viewer: "emperor", q: q.trim() || undefined, limit: 1000 }), [q], { watch: ["asset."], interval: 90_000 });
  const assets = list.data ?? [];

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    const inc = (k: string) => m.set(k, (m.get(k) ?? 0) + 1);
    for (const a of assets) {
      inc("all");
      if (a.owner === "court") inc("court");
      const d = deptOf(a.owner);
      if (d) inc(`dept:${d}`);
      if (a.owner.startsWith("dept:")) inc(`deptOnly:${d}`);
      if (a.owner.startsWith("post:")) inc(`post:${a.owner.slice(5)}`);
    }
    return m;
  }, [assets]);

  const shown = useMemo(() => assets.filter((a) => matchNode(a, node)).sort((a, b) => b.updated_at - a.updated_at), [assets, node]);
  const select = (id: string) => {
    const p = new URLSearchParams(params);
    if (id) p.set("id", id);
    else p.delete("id");
    setParams(p, { replace: true });
  };
  const nodeBtn = (n: Node, label: React.ReactNode, depth = 0, extra?: React.ReactNode) => {
    const k = nodeKey(n);
    return (
      <button key={k} className={`tree-node ${nodeKey(node) === k ? "active" : ""}`} style={{ paddingLeft: 10 + depth * 34 }} onClick={() => setNode(n)}>
        {extra}
        <span className="grow ellipsis">{label}</span>
        <span className="tree-count num">{counts.get(k) ?? 0}</span>
      </button>
    );
  };

  return (
    <div className="page ops-page">
      <PageHead title="资产库" lede="百官与诸司的文书、代码与数据。陛下可见一切；私产仅本人与陛下可见。" />
      <div className="assets-layout">
        <Card title="所藏" flush className="assets-tree">
          <div className="tree-search">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜路径…" />
          </div>
          <div className="tree">
            {nodeBtn({ kind: "all" }, "全部资产", 0, <span className="tree-seal ink">藏</span>)}
            {nodeBtn({ kind: "court" }, "朝廷公开", 0, <span className="tree-seal jade">公</span>)}
            {r.depts.map((d) => {
              const dk = `dept:${d.id}`;
              const open = openDepts[d.id] ?? (node.kind !== "all" && node.kind !== "court" && "id" in node && (node.id === d.id || node.id.startsWith(d.id + ".")));
              const ownersPosts = r.postsOfDept(d.id).filter((p) => (counts.get(`post:${p.post_id}`) ?? 0) > 0);
              return (
                <div key={d.id} className="tree-group">
                  <div className="row" style={{ gap: 0 }}>
                    <button className="tree-caret" onClick={() => setOpenDepts((o) => ({ ...o, [d.id]: !open }))} aria-label={open ? "收起" : "展开"} disabled={(counts.get(dk) ?? 0) === 0}>
                      {(counts.get(dk) ?? 0) === 0 ? "·" : open ? "▾" : "▸"}
                    </button>
                    <div className="grow">{nodeBtn({ kind: "dept", id: d.id }, d.name, 0, <span className="tree-seal">{DEPT_SEAL[d.id] ?? "部"}</span>)}</div>
                  </div>
                  {open && (
                    <>
                      {nodeBtn({ kind: "deptOnly", id: d.id }, "部门公产", 1)}
                      {ownersPosts.map((p) => nodeBtn({ kind: "post", id: p.post_id }, r.postLabel(p.post_id), 1))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </Card>

        <Card title="目录" sub={`${shown.length} 件`} flush className="assets-list">
          {list.initial ? (
            <Loading />
          ) : list.error && !list.data ? (
            <div className="card-body">
              <ErrorBox error={list.error} onRetry={list.reload} />
            </div>
          ) : shown.length === 0 ? (
            <Empty text={q ? "无匹配资产" : "此处尚无资产"} seal="空" />
          ) : (
            <div className="asset-rows">
              {shown.map((a) => {
                const k = kindOf(a.mime, a.path, a.mime.startsWith("image/") ? "base64" : "utf8");
                return (
                  <button key={a.id} className={`asset-row ${a.id === selectedId ? "active" : ""}`} onClick={() => select(a.id)}>
                    <span className={`asset-kind k-${k}`}>{KIND_LABEL[k]}</span>
                    <span className="grow" style={{ minWidth: 0 }}>
                      <span className="asset-path ellipsis" title={a.path}>
                        {a.path}
                      </span>
                      <span className="asset-meta">
                        <Addr a={a.owner} noLink /> · v{a.latest_version} · {fmtBytes(a.size)} · <TimeAgo ms={a.updated_at} />
                      </span>
                    </span>
                    <VisBadge a={a} />
                  </button>
                );
              })}
            </div>
          )}
        </Card>

        <div className="assets-preview">{selectedId ? <AssetPreview id={selectedId} key={selectedId} /> : <Card><Empty text="择一件资产以观其详" seal="阅" /></Card>}</div>
      </div>
    </div>
  );
}

function AssetPreview({ id }: { id: string }) {
  const [version, setVersion] = useState<number | undefined>(undefined);
  const [diff, setDiff] = useState(false);
  const cur = useQuery(() => hub.asset(id, "emperor", version), [id, version], { watch: (e) => e.type.startsWith("asset.") && e.subject_id === id });
  const versions = useQuery(() => hub.assetVersions(id, "emperor"), [id], { watch: (e) => e.type.startsWith("asset.") && e.subject_id === id });
  const latestNo = cur.data?.asset.latest_version;
  const viewingOld = version !== undefined && latestNo !== undefined && version !== latestNo;
  const latest = useQuery(() => hub.asset(id, "emperor"), [id], { enabled: viewingOld && diff });

  return (
    <QueryView q={cur}>
      {(c) => {
        const a = c.asset;
        const k = kindOf(a.mime, a.path, c.encoding);
        const textual = c.encoding === "utf8";
        return (
          <div className="stack">
            <Card
              memorial
              title={<span className="ellipsis" style={{ maxWidth: 420 }}>{a.path}</span>}
              actions={
                <>
                  <VisBadge a={a} />
                  <Tag>{a.mime}</Tag>
                </>
              }
            >
              <dl className="kv">
                <dt>所有</dt>
                <dd>
                  <Addr a={a.owner} />
                  {a.owner_official && <span className="muted small"> （官员 {a.owner_official}，随人迁转）</span>}
                </dd>
                {a.shared_with.length > 0 && (
                  <>
                    <dt>共享</dt>
                    <dd className="row wrap" style={{ gap: 6 }}>
                      {a.shared_with.map((s) => (
                        <Addr key={s} a={s} />
                      ))}
                    </dd>
                  </>
                )}
                <dt>版本</dt>
                <dd>
                  第 {c.version} 版 / 共 {a.latest_version} 版 · {fmtBytes(a.size)}
                </dd>
                <dt>校验</dt>
                <dd className="mono small muted ellipsis">{a.sha256}</dd>
                <dt>追踪</dt>
                <dd>
                  <TraceLink id={a.trace_id} />
                </dd>
                <dt>时间</dt>
                <dd className="small">
                  立于 {fmtDateTime(a.created_at)} · 改于 {fmtDateTime(a.updated_at)}
                </dd>
              </dl>
            </Card>

            <Card
              title="内容"
              sub={viewingOld ? `第 ${c.version} 版（旧）` : "最新版"}
              actions={
                viewingOld && textual ? (
                  <button className={`btn sm ${diff ? "gold" : ""}`} onClick={() => setDiff(!diff)}>
                    {diff ? "看原文" : `与最新版（v${latestNo}）对比`}
                  </button>
                ) : undefined
              }
            >
              {viewingOld && diff ? (
                latest.data ? (
                  <DiffView before={c.content} after={latest.data.content} labels={[`v${c.version}`, `v${latestNo}`]} />
                ) : latest.error ? (
                  <ErrorBox error={latest.error} />
                ) : (
                  <Loading />
                )
              ) : (
                <AssetBody kind={k} content={c.content} mime={a.mime} size={a.size} />
              )}
            </Card>

            <Card title="版本" sub="每次写入皆存新版" flush>
              <QueryView q={versions} empty={<Empty text="无版本记录" />}>
                {(vs) => (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th>版</th>
                        <th>作者</th>
                        <th className="num">大小</th>
                        <th>时间</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {[...vs]
                        .sort((x, y) => y.version - x.version)
                        .map((v) => {
                          const active = (version ?? latestNo) === v.version;
                          return (
                            <tr key={v.version} className={`clickable ${active ? "selected" : ""}`} onClick={() => setVersion(v.version === latestNo ? undefined : v.version)}>
                              <td className="mono">v{v.version}</td>
                              <td>
                                <Addr a={v.author} />
                              </td>
                              <td className="num">{fmtBytes(v.size)}</td>
                              <td className="small">
                                <TimeAgo ms={v.created_at} />
                              </td>
                              <td className="small">{v.version === latestNo ? <Tag tone="jade">最新</Tag> : active ? <Tag tone="gold">查看中</Tag> : null}</td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                )}
              </QueryView>
            </Card>
          </div>
        );
      }}
    </QueryView>
  );
}

function AssetBody({ kind, content, mime, size }: { kind: Kind; content: string; mime: string; size: number }) {
  switch (kind) {
    case "image":
      return (
        <div className="asset-image">
          <img src={`data:${mime};base64,${content}`} alt="资产图像" />
        </div>
      );
    case "binary":
      return <Empty text={`二进制资产（${mime}，${fmtBytes(size)}），不便预览`} seal="器" />;
    case "markdown":
      return <Markdown text={content} />;
    case "json":
      return <JsonView value={content} maxHeight={560} />;
    case "code":
      return <pre className="code-block" style={{ maxHeight: 560 }}>{content}</pre>;
    default:
      return <pre className="code-block plain-text" style={{ maxHeight: 560 }}>{content}</pre>;
  }
}
