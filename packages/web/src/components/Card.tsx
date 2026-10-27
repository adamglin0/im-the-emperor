import type { CSSProperties, ReactNode } from "react";

export function Card({
  title,
  sub,
  actions,
  children,
  memorial,
  urgent,
  flush,
  className = "",
  style,
  level = 2,
  id,
}: {
  title?: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  children?: ReactNode;
  /** 奏折样式：上下鎏金双线 */
  memorial?: boolean;
  urgent?: boolean;
  flush?: boolean;
  className?: string;
  style?: CSSProperties;
  level?: 2 | 3;
  id?: string;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <section id={id} className={`card ${memorial ? "memorial" : ""} ${urgent ? "urgent" : ""} ${className}`} style={style}>
      {(title || actions) && (
        <header className="card-head">
          {title && <H>{title}</H>}
          {sub && <span className="sub">{sub}</span>}
          {actions && <div className="actions">{actions}</div>}
        </header>
      )}
      <div className={`card-body ${flush ? "flush" : ""}`}>{children}</div>
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  unit?: string;
  sub?: ReactNode;
  tone?: "red" | "jade" | "azure";
}) {
  return (
    <div className={`stat ${tone ?? ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value">
        {value}
        {unit && <span className="stat-unit">{unit}</span>}
      </div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

export function PageHead({ title, lede, actions, children }: { title: ReactNode; lede?: ReactNode; actions?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {lede && <div className="lede">{lede}</div>}
      </div>
      {children}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}
