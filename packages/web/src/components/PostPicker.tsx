// 可搜索的职位/部门选择器：值为地址（post:x / dept:y）或纯 post_id（mode="post"）
import { useMemo, useRef, useState } from "react";
import { useRegistry } from "../api/registry.tsx";

interface Option {
  value: string;
  label: string;
  sub: string;
  search: string;
}

export function PostPicker({
  value,
  onChange,
  mode = "address",
  includeDepts = true,
  placeholder = "搜索职位、官员或部门…",
}: {
  value: string;
  onChange: (v: string) => void;
  /** address：返回 post:x / dept:y；post：只返回 post_id */
  mode?: "address" | "post";
  includeDepts?: boolean;
  placeholder?: string;
}) {
  const r = useRegistry();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const options = useMemo<Option[]>(() => {
    const out: Option[] = [];
    if (includeDepts && mode === "address") {
      for (const d of r.depts) out.push({ value: `dept:${d.id}`, label: d.name, sub: `部门 · ${d.brief}`, search: `${d.name}${d.id}${d.brief}` });
    }
    for (const p of r.posts) {
      const o = r.officialOf(p.post_id);
      out.push({
        value: mode === "address" ? `post:${p.post_id}` : p.post_id,
        label: `${p.title}${o ? ` ${o.name}` : "（空缺）"}`,
        sub: `${r.deptName(p.dept)} · ${p.rank}`,
        search: `${p.title}${o?.name ?? ""}${p.post_id}${r.deptName(p.dept)}`,
      });
    }
    return out;
  }, [r, mode, includeDepts]);
  const filtered = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (k ? options.filter((o) => o.search.toLowerCase().includes(k)) : options).slice(0, 60);
  }, [q, options]);
  const current = options.find((o) => o.value === value);

  const pick = (o: Option) => {
    onChange(o.value);
    setQ("");
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div className="picker qsearch" style={{ width: "100%" }}>
      <span className="qs-icon">寻</span>
      <input
        ref={inputRef}
        type="search"
        value={open ? q : (current?.label ?? value)}
        placeholder={placeholder}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => {
          setQ(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") setActive((a) => Math.min(a + 1, filtered.length - 1));
          else if (e.key === "ArrowUp") setActive((a) => Math.max(a - 1, 0));
          else if (e.key === "Enter" && filtered[active]) {
            e.preventDefault();
            pick(filtered[active]);
          }
        }}
      />
      {open && (
        <div className="qs-pop">
          {filtered.length === 0 && <div className="qs-item muted">无匹配</div>}
          {filtered.map((o, i) => (
            <div key={o.value} className={`qs-item ${i === active ? "active" : ""}`} onMouseDown={() => pick(o)} onMouseEnter={() => setActive(i)}>
              <span className="grow">{o.label}</span>
              <span className="muted small">{o.sub}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
