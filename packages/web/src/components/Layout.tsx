// 外框：左侧印章导航 + 顶栏（标题、速查、驿路灯、待办、主题）+ 横幅（失联/罢朝/样例）
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { hub, fixtureMode } from "../api/client.ts";
import { useSse } from "../api/events.tsx";
import { useRegistry } from "../api/registry.tsx";
import { useBackendDown } from "../hooks/backend.ts";
import { useLocalState } from "../hooks/useLocalState.ts";
import { useQuery } from "../hooks/useQuery.ts";
import { Seal } from "./Seal.tsx";
import { fmtAgo } from "../lib/format.ts";

interface NavDef {
  to: string;
  seal: string;
  label: string;
  end?: boolean;
}
const NAV: { group: string; items: NavDef[] }[] = [
  {
    group: "御前",
    items: [
      { to: "/", seal: "御", label: "御书房", end: true },
      { to: "/council", seal: "议", label: "政事堂" },
      { to: "/decree", seal: "旨", label: "颁旨·口谕" },
    ],
  },
  {
    group: "政务",
    items: [
      { to: "/edicts", seal: "诏", label: "诏令调查" },
      { to: "/court", seal: "朝", label: "朝堂" },
      { to: "/schedules", seal: "时", label: "定时任务" },
      { to: "/assets", seal: "藏", label: "资产库" },
    ],
  },
  {
    group: "有司",
    items: [
      { to: "/ledger", seal: "账", label: "户部账本" },
      { to: "/libu", seal: "吏", label: "吏部铨选" },
      { to: "/exams", seal: "举", label: "科举" },
      { to: "/censor", seal: "宪", label: "御史台" },
    ],
  },
  { group: "驿传", items: [{ to: "/feed", seal: "驿", label: "驿报" }] },
  { group: "内廷", items: [{ to: "/settings", seal: "设", label: "设置" }] },
];

const TITLES: [RegExp, string][] = [
  [/^\/$/, "御书房"],
  [/^\/council/, "政事堂议事厅"],
  [/^\/decree/, "颁旨 · 口谕 · 私聊"],
  [/^\/edicts\/.+/, "诏令调查"],
  [/^\/edicts/, "诏令"],
  [/^\/court/, "朝堂"],
  [/^\/depts\//, "部门"],
  [/^\/officials\//, "官员"],
  [/^\/schedules/, "定时任务"],
  [/^\/assets/, "资产库"],
  [/^\/ledger/, "户部账本"],
  [/^\/libu/, "吏部"],
  [/^\/exams/, "科举"],
  [/^\/censor/, "御史台"],
  [/^\/feed/, "驿报"],
  [/^\/settings/, "设置 · 模型提供商"],
];

type ThemePref = "system" | "light" | "dark";

function useTheme(): [ThemePref, () => void] {
  const [pref, setPref] = useLocalState<ThemePref>("court.theme.pref", "system");
  useEffect(() => {
    const root = document.documentElement;
    if (pref === "system") {
      delete root.dataset.theme;
      try {
        localStorage.removeItem("court.theme");
      } catch {
        /* 忽略 */
      }
    } else {
      root.dataset.theme = pref;
      try {
        localStorage.setItem("court.theme", pref);
      } catch {
        /* 忽略 */
      }
    }
  }, [pref]);
  const cycle = () => setPref(pref === "system" ? "light" : pref === "light" ? "dark" : "system");
  return [pref, cycle];
}

export function Layout() {
  const loc = useLocation();
  const { state, lastAt } = useSse();
  const backend = useBackendDown();
  const [pref, cycleTheme] = useTheme();
  const [collapsed, setCollapsed] = useLocalState("court.nav.collapsed", false);
  const ov = useQuery(() => hub.overview(), [], { watch: ["notification.", "edict.state", "task.state", "court.halt"], interval: 30_000 });
  const pending = ov.data?.pending_notifications ?? 0;
  const title = TITLES.find(([re]) => re.test(loc.pathname))?.[1] ?? "";
  useEffect(() => {
    document.title = `${title ? title + " · " : ""}朕即天下`;
  }, [title]);

  const lampText = state === "open" ? `驿路通${lastAt ? ` · ${fmtAgo(lastAt)}` : ""}` : state === "connecting" ? "驿路连接中" : "驿路断绝";

  return (
    <div className={`shell ${collapsed ? "nav-collapsed" : ""}`}>
      <nav className="nav" aria-label="主导航">
        <Link to="/" className="nav-brand" title="朕即天下">
          <Seal text="朕" tone="red" solid size={32} rotate={-6} />
          <div>
            <div className="brand-text">朕即天下</div>
            <div className="brand-sub">三省六部 · 御前</div>
          </div>
        </Link>
        {NAV.map((g) => (
          <div key={g.group} className="nav-group">
            <div className="nav-group-title">{g.group}</div>
            {g.items.map((it) => (
              <NavLink key={it.to} to={it.to} end={it.end} className={({ isActive }) => `nav-item ${isActive ? "active" : ""}`} title={it.label}>
                <span className="nav-seal">{it.seal}</span>
                <span className="nav-label">{it.label}</span>
                {it.to === "/" && pending > 0 && <span className="nav-count">{pending}</span>}
              </NavLink>
            ))}
          </div>
        ))}
        <div className="nav-foot">
          <button className="btn ghost sm" style={{ color: "var(--nav-ink-2)" }} onClick={() => setCollapsed(!collapsed)} title={collapsed ? "展开" : "收起"}>
            {collapsed ? "»" : "«"}
          </button>
          <span> 武德—贞观制</span>
        </div>
      </nav>

      <header className="topbar">
        <div className="page-title">{title}</div>
        {fixtureMode.on && (
          <span className="tag gold" title="?fixtures=0 退出">
            样例数据
          </span>
        )}
        <div className="spacer" />
        <QuickSearch />
        <span className={`live-lamp ${state === "open" ? "on" : state === "closed" ? "off" : ""}`} title={lampText}>
          <span className="dot" />
          <span className="label">{lampText}</span>
        </span>
        <Link to="/" className="btn ghost sm" title="待办" aria-label={`待办 ${pending} 件`}>
          <span className="display">奏</span>
          {pending > 0 ? <span className="count-badge">{pending}</span> : <span className="muted small">0</span>}
        </Link>
        <button className="btn ghost sm" onClick={cycleTheme} title="切换主题：随系统 / 宣纸 / 墨夜">
          <span className="display">{pref === "system" ? "随" : pref === "light" ? "昼" : "夜"}</span>
        </button>
      </header>

      <main className="main" id="main">
        {backend.down && (
          <div className="banner bad" role="alert">
            <Seal text="断" tone="red" size={22} />
            皇城失联：无法连接后端（{fmtAgo(backend.since)}起）。页面显示的是最后一次取得的数据，将自动重试。
          </div>
        )}
        {ov.data?.halted && <div className="banner halt">罢　朝　中 · 百官暂停办事 · 网关拒绝一切调用</div>}
        <Outlet />
      </main>
    </div>
  );
}

function QuickSearch() {
  const r = useRegistry();
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const edicts = useQuery(() => hub.edicts({ limit: 100 }), [], { enabled: open, interval: 0 });
  const results = useMemo(() => {
    const k = q.trim().toLowerCase();
    if (!k) return [];
    const out: { href: string; label: string; sub: string }[] = [];
    for (const d of r.depts) if (`${d.name}${d.id}`.toLowerCase().includes(k)) out.push({ href: `/depts/${d.id}`, label: d.name, sub: "部门" });
    for (const p of r.posts) {
      const o = r.officialOf(p.post_id);
      if (`${p.title}${o?.name ?? ""}${p.post_id}`.toLowerCase().includes(k)) out.push({ href: `/officials/${p.post_id}`, label: `${p.title} ${o?.name ?? "（空缺）"}`, sub: r.deptName(p.dept) });
    }
    for (const e of edicts.data ?? []) if (`${e.title}${e.id}`.toLowerCase().includes(k)) out.push({ href: `/edicts/${e.id}`, label: e.title, sub: "诏令" });
    if (/^(tr_|ed_|edict)/i.test(k)) out.push({ href: `/edicts/${q.trim()}`, label: `打开 ${q.trim()}`, sub: "按 ID" });
    return out.slice(0, 14);
  }, [q, r, edicts.data]);
  const go = (href: string) => {
    nav(href);
    setQ("");
    setOpen(false);
  };
  return (
    <div className="qsearch">
      <span className="qs-icon">寻</span>
      <input
        type="search"
        placeholder="速查：官员、部门、诏令…"
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(0, a - 1));
          else if (e.key === "Enter" && results[active]) go(results[active].href);
          else if (e.key === "Escape") setOpen(false);
        }}
        aria-label="速查"
      />
      {open && results.length > 0 && (
        <div className="qs-pop">
          {results.map((x, i) => (
            <div key={x.href + i} className={`qs-item ${i === active ? "active" : ""}`} onMouseDown={() => go(x.href)} onMouseEnter={() => setActive(i)}>
              <span className="grow ellipsis">{x.label}</span>
              <span className="muted small">{x.sub}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
