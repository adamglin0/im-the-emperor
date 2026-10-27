// 宏观执行图：React Flow 渲染 + dagre 布局（左→右）。节点为小奏折卡，印章示状态。
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Background, Controls, Handle, MarkerType, Position, ReactFlow, useReactFlow, type Edge, type Node, type NodeProps } from "@xyflow/react";
import { Graph, layout } from "@dagrejs/dagre";
import { useRegistry } from "../../api/registry.tsx";
import { Seal } from "../../components/Seal.tsx";
import { fmtDuration, fmtTokens } from "../../lib/format.ts";
import { nodeDuration, statusSeal, type MacroGraph, type MacroNode } from "./model.ts";

const FIT_OPTS = { padding: 0.08, maxZoom: 1.05 };

/** 节点增减（诏令推进、实时刷新）或容器高度变化时重新取景；fitView 属性只在首次挂载生效 */
function AutoFit({ count, height }: { count: number; height: number }) {
  const rf = useReactFlow();
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = setTimeout(() => void rf.fitView({ ...FIT_OPTS, duration: 200 }), 30);
    return () => clearTimeout(t);
  }, [count, height, rf]);
  return null;
}

const NODE_W = 212;
const NODE_H = 82;
const GAP = 30;

interface NodeData extends Record<string, unknown> {
  n: MacroNode;
  actorLabel: string;
  critical: boolean;
  dim: boolean;
  future: boolean;
  selected: boolean;
  now: number;
}
type FlowNode = Node<NodeData, "macro">;

const MacroCard = memo(function MacroCard({ data }: NodeProps<FlowNode>) {
  const { n, actorLabel, critical, dim, future, selected, now } = data;
  const seal = statusSeal(n);
  const d = nodeDuration(n, now);
  const live = n.status === "running" || n.status === "blocked";
  return (
    <div
      className={`mc mc-${n.kind} st-${n.status} ${critical ? "crit" : ""} ${dim ? "dim" : ""} ${future ? "future" : ""} ${selected ? "sel" : ""} ${n.status === "blocked" ? "pulse-ring" : ""}`}
      title={`${n.label}：${n.title}`}
    >
      <Handle type="target" position={Position.Left} id="l-t" className="mc-h" />
      <Handle type="source" position={Position.Left} id="l-s" className="mc-h" style={{ top: "70%" }} />
      <Handle type="source" position={Position.Right} id="r-s" className="mc-h" />
      <Handle type="source" position={Position.Bottom} id="b-s" className="mc-h" />
      <Handle type="target" position={Position.Top} id="t-t" className="mc-h" />
      <div className="mc-top">
        <span className="mc-kind">{n.label}</span>
        <Seal text={seal.text} tone={seal.tone} size={22} solid={n.status === "rejected" || n.status === "blocked"} />
      </div>
      <div className="mc-title">{n.title}</div>
      <div className="mc-foot">
        <span className="mc-actor ellipsis">{actorLabel}</span>
        <span className="mc-badges">
          {d !== undefined && (
            <span className="mc-badge" title="耗时">
              {live && <i className="dot-state pulse" style={{ width: 5, height: 5, marginRight: 3 }} />}
              {fmtDuration(d)}
            </span>
          )}
          {n.tokens > 0 && (
            <span className="mc-badge tok" title={`${n.calls} 次调用`}>
              {fmtTokens(n.tokens)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
});

const nodeTypes = { macro: MacroCard };

const EDGE_STYLE: Record<string, { stroke: string; dash?: string; width: number }> = {
  flow: { stroke: "var(--ink-3)", width: 1.4 },
  redraft: { stroke: "var(--azure)", width: 1.4, dash: "5 3" },
  reject: { stroke: "var(--vermilion)", width: 1.8, dash: "6 3" },
  message: { stroke: "var(--jade)", width: 1, dash: "2 3" },
  service: { stroke: "var(--gold)", width: 1.2, dash: "2 3" },
  causes: { stroke: "var(--plum)", width: 1, dash: "2 3" },
};

export function Dag({
  g,
  selected,
  onSelect,
  matches,
  cursor,
  showLinks,
  now,
}: {
  g: MacroGraph;
  selected?: string;
  onSelect: (nodeId: string) => void;
  matches: (n: MacroNode) => boolean;
  cursor: number | null;
  showLinks: boolean;
  now: number;
}) {
  const r = useRegistry();
  // 布局：同一「卷」纵向叠放（议事+圣旨；草稿 vN + 其审核），卷之间由 dagre 左→右排布。
  // 只取结构边参与布局，消息连线不参与。
  const { positions, groupOf } = useMemo(() => {
    const groups = new Map<string, string[]>();
    const groupOf = new Map<string, string>();
    const put = (gid: string, nid: string) => {
      if (!g.nodeById.has(nid) || groupOf.has(nid)) return;
      const arr = groups.get(gid) ?? [];
      arr.push(nid);
      groups.set(gid, arr);
      groupOf.set(nid, gid);
    };
    if (g.nodeById.has("n:delib")) put("g:root", "n:delib");
    put("g:root", g.rootId);
    for (const n of g.nodes) {
      if (n.kind !== "draft") continue;
      const gid = `g:draft:${n.ref.draft_no}`;
      put(gid, n.id);
      for (const r of g.nodes) if (r.kind === "review" && r.ref.draft_no === n.ref.draft_no) put(gid, r.id);
    }
    for (const n of g.nodes) put(`g:${n.id}`, n.id);
    const dg = new Graph({ multigraph: false });
    dg.setGraph({ rankdir: "LR", nodesep: 18, ranksep: 46, marginx: 10, marginy: 10 });
    dg.setDefaultEdgeLabel(() => ({}));
    for (const [gid, members] of groups) dg.setNode(gid, { width: NODE_W, height: members.length * NODE_H + (members.length - 1) * GAP });
    for (const e of g.edges) {
      if (e.kind !== "flow" && e.kind !== "redraft") continue;
      const a = groupOf.get(e.source);
      const b = groupOf.get(e.target);
      if (a && b && a !== b) dg.setEdge(a, b);
    }
    layout(dg);
    const pos = new Map<string, { x: number; y: number }>();
    for (const [gid, members] of groups) {
      const p = dg.node(gid) as { x: number; y: number; height: number } | undefined;
      const h = members.length * NODE_H + (members.length - 1) * GAP;
      members.forEach((nid, i) => pos.set(nid, { x: (p?.x ?? 0) - NODE_W / 2, y: (p?.y ?? 0) - h / 2 + i * (NODE_H + GAP) }));
    }
    return { positions: pos, groupOf };
  }, [g]);

  const nodes = useMemo<FlowNode[]>(
    () =>
      g.nodes.map((n) => ({
        id: n.id,
        type: "macro",
        position: positions.get(n.id) ?? { x: 0, y: 0 },
        // 受控 nodes 每次刷新都是新对象（无 onNodesChange 回写测量值）：给定尺寸，否则 React Flow 视为未测量而 visibility:hidden
        width: NODE_W,
        height: NODE_H,
        draggable: false,
        data: {
          n,
          actorLabel: n.actor ? r.addrLabel(n.actor) : n.dept ? r.deptName(n.dept) : "",
          critical: g.critical.nodes.has(n.id),
          dim: !matches(n),
          future: cursor !== null && (n.started_at ?? 0) > cursor,
          selected: selected === n.id,
          now,
        },
      })),
    [g, positions, r, matches, cursor, selected, now],
  );

  const edges = useMemo<Edge[]>(
    () =>
      g.edges
        .filter((e) => showLinks || e.kind === "flow" || e.kind === "redraft" || e.kind === "reject")
        .map((e) => {
          const st = EDGE_STYLE[e.kind] ?? EDGE_STYLE.flow;
          const crit = g.critical.edges.has(e.id);
          const target = g.nodeById.get(e.target);
          const color = crit ? "var(--gold-bright)" : st.stroke;
          const sameCol = groupOf.get(e.source) === groupOf.get(e.target);
          const handles =
            e.kind === "reject"
              ? { sourceHandle: "l-s", targetHandle: "l-t" }
              : sameCol
                ? { sourceHandle: "b-s", targetHandle: "t-t" }
                : { sourceHandle: "r-s", targetHandle: "l-t" };
          return {
            id: e.id,
            source: e.source,
            target: e.target,
            type: e.kind === "reject" ? "smoothstep" : sameCol ? "straight" : "default",
            ...handles,
            pathOptions: e.kind === "reject" ? { offset: 22, borderRadius: 10 } : undefined,
            animated: target?.status === "running" && (e.kind === "flow" || e.kind === "redraft"),
            label: e.kind === "reject" ? "↺ 封驳" : e.kind === "flow" ? undefined : e.label,
            labelStyle: { fill: e.kind === "reject" ? "var(--vermilion)" : "var(--ink-2)", fontSize: 11, fontFamily: "var(--font-serif)" },
            labelBgStyle: { fill: "var(--panel)" },
            labelBgPadding: [4, 2] as [number, number],
            style: { stroke: color, strokeWidth: crit ? 2.6 : st.width, strokeDasharray: st.dash },
            markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
            zIndex: e.kind === "reject" ? 1 : 0,
          } as Edge;
        }),
    [g, showLinks, groupOf],
  );

  // 高度随图形自适应：按容器宽度估算缩放
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cw, setCw] = useState(1100);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setCw(el.clientWidth));
    ro.observe(el);
    setCw(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const height = useMemo(() => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of positions.values()) {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x + NODE_W);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y + NODE_H);
    }
    if (!isFinite(minX)) return 320;
    const scale = Math.min(1.05, (cw * 0.92) / (maxX - minX));
    return Math.round(Math.min(680, Math.max(300, (maxY - minY) * scale + 90)));
  }, [positions, cw]);

  return (
    <div className="dag-wrap" ref={wrapRef} style={{ height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, n) => onSelect(n.id)}
        fitView
        fitViewOptions={FIT_OPTS}
        minZoom={0.2}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable={false}
        deleteKeyCode={null}
        elementsSelectable
        proOptions={{ hideAttribution: true }}
      >
        <AutoFit count={nodes.length} height={height} />
        <Background gap={22} size={1} color="var(--rule)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
