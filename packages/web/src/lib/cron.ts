// 定时规则：中文描述 + 下 N 次运行（Asia/Shanghai），基于 croner。
import { Cron } from "croner";
import type { ScheduleSpec } from "@court/shared/types";
import { TZ } from "./format.ts";

export const CRON_PRESETS: { label: string; cron: string }[] = [
  { label: "每日辰时 08:00", cron: "0 8 * * *" },
  { label: "每日午时 12:00", cron: "0 12 * * *" },
  { label: "每日酉时 18:00", cron: "0 18 * * *" },
  { label: "每日亥时 21:00", cron: "0 21 * * *" },
  { label: "每 2 小时", cron: "0 */2 * * *" },
  { label: "每 4 小时", cron: "0 */4 * * *" },
  { label: "每 30 分钟", cron: "*/30 * * * *" },
  { label: "工作日 09:30", cron: "30 9 * * 1-5" },
  { label: "每周一 09:00", cron: "0 9 * * 1" },
  { label: "每月初一 10:00", cron: "0 10 1 * *" },
];

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const SHICHEN = ["子", "丑", "丑", "寅", "寅", "卯", "卯", "辰", "辰", "巳", "巳", "午", "午", "未", "未", "申", "申", "酉", "酉", "戌", "戌", "亥", "亥", "子"];

function pad(n: number | string) {
  return String(n).padStart(2, "0");
}

/** 校验 5 段 cron，返回错误文字或 null */
export function validateCron(expr: string): string | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "须为 5 段：分 时 日 月 周";
  try {
    new Cron(expr, { timezone: TZ, paused: true });
    return null;
  } catch (e) {
    return `无法解析：${(e as Error).message}`;
  }
}

/** 5 段 cron → 中文 */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [mi, h, dom, mon, dow] = parts;
  const isNum = (s: string) => /^\d+$/.test(s);
  let time = "";
  if (isNum(mi) && isNum(h)) time = `${pad(h)}:${pad(mi)}（${SHICHEN[Number(h)]}时）`;
  else if (mi.startsWith("*/") && h === "*") time = `每 ${mi.slice(2)} 分钟`;
  else if (isNum(mi) && h.startsWith("*/")) time = `每 ${h.slice(2)} 小时（第 ${mi} 分）`;
  else if (isNum(mi) && h === "*") time = `每小时第 ${mi} 分`;
  else if (mi === "*" && h === "*") time = "每分钟";
  else if (isNum(mi) && /^[\d,]+$/.test(h)) time = `${h.split(",").map((x) => `${pad(x)}:${pad(mi)}`).join("、")}`;
  else if (isNum(mi) && /^\d+-\d+$/.test(h)) time = `${h.replace("-", "至")} 时每小时第 ${mi} 分`;
  else time = `${h} 时 ${mi} 分`;

  let day = "";
  if (dom === "*" && mon === "*" && dow === "*") day = "每日";
  else if (dom === "*" && mon === "*") {
    if (dow === "1-5") day = "工作日";
    else if (dow === "0,6" || dow === "6,0") day = "周末";
    else if (/^[\d,]+$/.test(dow)) day = "每周" + dow.split(",").map((d) => WEEK[Number(d) % 7]).join("、");
    else if (/^\d-\d$/.test(dow)) day = `每周${WEEK[Number(dow[0]) % 7]}至周${WEEK[Number(dow[2]) % 7]}`;
    else day = `周 ${dow}`;
  } else if (mon === "*" && dow === "*") {
    if (isNum(dom)) day = `每月 ${dom} 日`;
    else if (dom.startsWith("*/")) day = `每 ${dom.slice(2)} 日`;
    else day = `每月 ${dom} 日`;
  } else {
    day = `${mon === "*" ? "每月" : `${mon} 月`} ${dom === "*" ? "" : `${dom} 日`}${dow === "*" ? "" : ` 周${dow}`}`;
  }
  return `${day} ${time}`.trim();
}

export function describeSpec(spec: ScheduleSpec): string {
  if (spec.cron) return describeCron(spec.cron);
  if (spec.every_seconds) {
    const s = spec.every_seconds;
    if (s % 86400 === 0) return `每 ${s / 86400} 日`;
    if (s % 3600 === 0) return `每 ${s / 3600} 小时`;
    if (s % 60 === 0) return `每 ${s / 60} 分钟`;
    return `每 ${s} 秒`;
  }
  if (spec.at) {
    return `一次：${new Intl.DateTimeFormat("zh-CN", { timeZone: TZ, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(spec.at)}`;
  }
  return "—";
}

/** 下 N 次运行时间（毫秒） */
export function nextRuns(spec: ScheduleSpec, n = 5, from = Date.now()): number[] {
  if (spec.cron) {
    try {
      const c = new Cron(spec.cron, { timezone: TZ, paused: true });
      return c.nextRuns(n, new Date(from)).map((d) => d.getTime());
    } catch {
      return [];
    }
  }
  if (spec.every_seconds && spec.every_seconds > 0) {
    const step = spec.every_seconds * 1000;
    const first = Math.ceil(from / step) * step;
    return Array.from({ length: n }, (_, i) => first + i * step);
  }
  if (spec.at) return spec.at > from ? [spec.at] : [];
  return [];
}

/** 区间内全部运行时间（热力条用），最多 max 个 */
export function runsBetween(spec: ScheduleSpec, from: number, to: number, max = 500): number[] {
  const out: number[] = [];
  for (const t of nextRuns(spec, max, from)) {
    if (t > to) break;
    out.push(t);
  }
  return out;
}

/** 最小间隔（秒），用于提示「低于 5 分钟」 */
export function minIntervalSeconds(spec: ScheduleSpec): number | null {
  const r = nextRuns(spec, 6);
  if (r.length < 2) return null;
  let min = Infinity;
  for (let i = 1; i < r.length; i++) min = Math.min(min, (r[i] - r[i - 1]) / 1000);
  return min;
}
