// B 组（流程）公共工具：入参校验（中文、可操作的报错）、小工具函数。
import type { Address } from "@court/shared";
import { bad } from "../ctx.ts";

export type Body = Record<string, unknown>;

export function asBody(v: unknown): Body {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw bad("请求体必须是 JSON 对象");
  return v as Body;
}

/** 必填字符串（去首尾空白后非空） */
export function reqStr(v: unknown, label: string, max = 20_000): string {
  if (typeof v !== "string" || !v.trim()) throw bad(`缺少「${label}」（必须是非空字符串）`);
  if (v.length > max) throw bad(`「${label}」过长（${v.length} 字符，上限 ${max}），请精简后重试`);
  return v.trim();
}

export function optStr(v: unknown, label: string, max = 20_000): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw bad(`「${label}」必须是字符串`);
  if (v.length > max) throw bad(`「${label}」过长（${v.length} 字符，上限 ${max}），请精简后重试`);
  return v.trim();
}

export function reqEnum<T extends string>(v: unknown, allowed: readonly T[], label: string): T {
  if (typeof v !== "string" || !allowed.includes(v as T)) {
    throw bad(`「${label}」取值无效：${JSON.stringify(v)}；可选值：${allowed.join(" / ")}`);
  }
  return v as T;
}

export function optEnum<T extends string>(v: unknown, allowed: readonly T[], label: string): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return reqEnum(v, allowed, label);
}

export function optNum(v: unknown, label: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw bad(`「${label}」必须是数字`);
  if (n < min || n > max) throw bad(`「${label}」超出范围（${min}–${max}），当前 ${n}`);
  return n;
}

export function reqNum(v: unknown, label: string, min: number, max: number): number {
  const n = optNum(v, label, min, max);
  if (n === undefined) throw bad(`缺少「${label}」（数字，${min}–${max}）`);
  return n;
}

export function reqBool(v: unknown, label: string): boolean {
  if (typeof v !== "boolean") throw bad(`「${label}」必须是 true 或 false`);
  return v;
}

export function optBool(v: unknown, label: string): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  return reqBool(v, label);
}

export function reqArr(v: unknown, label: string, min = 0, max = 200): unknown[] {
  if (!Array.isArray(v)) throw bad(`「${label}」必须是数组`);
  if (v.length < min) throw bad(`「${label}」至少需要 ${min} 项`);
  if (v.length > max) throw bad(`「${label}」最多 ${max} 项，当前 ${v.length} 项`);
  return v;
}

export function optStrArr(v: unknown, label: string, max = 200): string[] {
  if (v === undefined || v === null) return [];
  const arr = reqArr(v, label, 0, max);
  for (const x of arr) if (typeof x !== "string" || !x.trim()) throw bad(`「${label}」的每一项都必须是非空字符串`);
  return (arr as string[]).map((s) => s.trim());
}

export function checkVersion(expected: unknown, current: number, conflict: (cur: number) => Error): void {
  if (expected === undefined || expected === null) return;
  if (typeof expected !== "number" || expected !== current) throw conflict(current);
}

export const postAddress = (post: string): Address => `post:${post}`;

/** "post:x" → "x"；其他地址返回 undefined */
export function postOfAddress(a: Address | undefined): string | undefined {
  return a && a.startsWith("post:") ? a.slice(5) : undefined;
}

export function clip(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

export function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

/** 去重保序 */
export function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}
