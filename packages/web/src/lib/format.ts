// 数字、时间格式化（时区 Asia/Shanghai）
export const TZ = "Asia/Shanghai";

const dtf = new Intl.DateTimeFormat("zh-CN", {
  timeZone: TZ,
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
const tf = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const df = new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });

export function fmtDateTime(ms?: number | null): string {
  if (!ms) return "—";
  return dtf.format(ms);
}
export function fmtTime(ms?: number | null): string {
  if (!ms) return "—";
  return tf.format(ms);
}
export function fmtDate(ms?: number | null): string {
  if (!ms) return "—";
  return df.format(ms);
}
/** YYYY-MM-DD（上海时区），日志按日文件名用 */
export function isoDate(ms: number): string {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
  return p;
}

/**
 * 账本「时辰」分组键 → 毫秒。hub 返回北京时间 "YYYY-MM-DD HH:00"；
 * 兼容 epoch 毫秒/秒与带时区的 ISO 字符串。
 */
export function hourKeyMs(k: string): number | undefined {
  if (/^\d+$/.test(k)) {
    const n = Number(k);
    if (n > 1e12) return n;
    if (n > 1e9) return n * 1000;
    return undefined;
  }
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2})(?::(\d{2}))?(?::\d{2}(?:\.\d+)?)?$/.exec(k.trim());
  if (m) {
    const t = Date.parse(`${m[1]}T${m[2]}:${m[3] ?? "00"}:00+08:00`);
    return Number.isNaN(t) ? undefined : t;
  }
  const t = Date.parse(k);
  return Number.isNaN(t) ? undefined : t;
}

/** 相对时间：3分钟前 / 2小时后 */
export function fmtAgo(ms?: number | null, now = Date.now()): string {
  if (!ms) return "—";
  const d = ms - now;
  const a = Math.abs(d);
  const suffix = d < 0 ? "前" : "后";
  if (a < 10_000) return d < 0 ? "刚刚" : "即刻";
  if (a < 60_000) return `${Math.round(a / 1000)}秒${suffix}`;
  if (a < 3_600_000) return `${Math.round(a / 60_000)}分钟${suffix}`;
  if (a < 86_400_000) return `${(a / 3_600_000).toFixed(a < 36_000_000 ? 1 : 0)}小时${suffix}`;
  return `${Math.round(a / 86_400_000)}天${suffix}`;
}

/** 时长：850ms / 12.3s / 4分12秒 / 2时5分 */
export function fmtDuration(ms?: number | null): string {
  if (ms === undefined || ms === null || !isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}分${Math.round((ms % 60_000) / 1000)}秒`;
  return `${Math.floor(ms / 3_600_000)}时${Math.round((ms % 3_600_000) / 60_000)}分`;
}

/** token 数：1,234 / 1.2万 / 3.4亿 */
export function fmtTokens(n?: number | null): string {
  if (n === undefined || n === null || !isFinite(n)) return "—";
  if (Math.abs(n) < 10_000) return Math.round(n).toLocaleString("zh-CN");
  if (Math.abs(n) < 100_000_000) return `${(n / 10_000).toFixed(n < 100_000 ? 2 : 1)}万`;
  return `${(n / 100_000_000).toFixed(2)}亿`;
}
/** 紧凑英文单位（图表轴） */
export function fmtCompact(n: number): string {
  if (Math.abs(n) >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e4).toFixed(n >= 1e5 ? 0 : 1)}万`;
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n * 100) / 100);
}
export function fmtCost(usd?: number | null): string {
  if (usd === undefined || usd === null || !isFinite(usd)) return "—";
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 10) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}
export function fmtPct(x?: number | null, digits = 0): string {
  if (x === undefined || x === null || !isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}
export function fmtBytes(n?: number): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}
/** 上海时区今日 0 点的毫秒 */
export function startOfTodayShanghai(now = Date.now()): number {
  const offset = 8 * 3_600_000;
  return Math.floor((now + offset) / 86_400_000) * 86_400_000 - offset;
}
export function truncate(s: string | undefined | null, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n) + "…" : s;
}
