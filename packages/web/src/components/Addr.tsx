// 地址显示：朕 / 职衔+姓名（可点进职位页）/ 部门
import { Link } from "react-router";
import type { Address } from "@court/shared/types";
import { useRegistry } from "../api/registry.tsx";
import { fmtAgo, fmtDateTime } from "../lib/format.ts";
import { useNow } from "../hooks/useNow.ts";

export function Addr({ a, noLink, withName = true, className }: { a: Address | undefined; noLink?: boolean; withName?: boolean; className?: string }) {
  const r = useRegistry();
  const label = r.addrLabel(a, withName);
  const href = noLink ? undefined : r.addrHref(a);
  if (a === "emperor") return <span className={`addr-emperor ${className ?? ""}`}>朕</span>;
  return href ? (
    <Link to={href} className={className} onClick={(e) => e.stopPropagation()}>
      {label}
    </Link>
  ) : (
    <span className={className}>{label}</span>
  );
}

export function TimeAgo({ ms, abs }: { ms?: number | null; abs?: boolean }) {
  const now = useNow();
  if (!ms) return <span className="muted">—</span>;
  return (
    <time dateTime={new Date(ms).toISOString()} title={fmtDateTime(ms)}>
      {abs ? fmtDateTime(ms) : fmtAgo(ms, now)}
    </time>
  );
}

/** trace 链接：诏令 id 即 trace_id */
export function TraceLink({ id, children }: { id?: string; children?: React.ReactNode }) {
  if (!id) return <span className="muted">—</span>;
  return (
    <Link to={`/edicts/${id}`} className="mono" onClick={(e) => e.stopPropagation()}>
      {children ?? id}
    </Link>
  );
}
