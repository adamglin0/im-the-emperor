import { randomBytes, createHash } from "node:crypto";

const ALPHA = "0123456789abcdefghjkmnpqrstvwxyz";

/** 时间有序的短 ID：前缀_时间(base32)随机 */
export function newId(prefix: string): string {
  let t = Date.now();
  let ts = "";
  for (let i = 0; i < 9; i++) {
    ts = ALPHA[t % 32] + ts;
    t = Math.floor(t / 32);
  }
  const r = randomBytes(6);
  let rnd = "";
  for (const b of r) rnd += ALPHA[b % 32];
  return `${prefix}_${ts}${rnd}`;
}

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** 可中断的等待；无论超时还是中断都会移除监听，避免长跑进程泄漏 */
export const sleepMs = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export function truncate(s: string, maxBytes: number): { text: string; truncated: boolean } {
  const buf = Buffer.from(s, "utf8");
  if (buf.length <= maxBytes) return { text: s, truncated: false };
  const head = buf.subarray(0, Math.floor(maxBytes * 0.7)).toString("utf8");
  const tail = buf.subarray(buf.length - Math.floor(maxBytes * 0.25)).toString("utf8");
  return { text: `${head}\n…［已截断 ${buf.length - maxBytes} 字节］…\n${tail}`, truncated: true };
}

/** 粗略 token 估算（与 pi-coding-agent 一致：字符数/4，中文按 1 字 ≈ 1 token 修正） */
export function estimateTokens(s: string): number {
  let cjk = 0;
  for (const ch of s) if (ch.charCodeAt(0) > 0x2e80) cjk++;
  return Math.ceil((s.length - cjk) / 4 + cjk);
}

export function parseAddress(a: string): { type: "emperor" | "post" | "dept" | "system" | "court"; id: string } {
  if (a === "emperor") return { type: "emperor", id: "emperor" };
  if (a === "court") return { type: "court", id: "court" };
  const i = a.indexOf(":");
  if (i < 0) throw new Error(`非法地址: ${a}`);
  const type = a.slice(0, i) as "post" | "dept" | "system";
  if (!["post", "dept", "system"].includes(type)) throw new Error(`非法地址: ${a}`);
  return { type, id: a.slice(i + 1) };
}

export const postAddr = (p: string) => `post:${p}`;
/** hub 公文对象（诏令/任务/服务请求/议事）的 span_id 约定：sp_<对象 id> */
export const objectSpanId = (objectId: string) => `sp_${objectId}`;
export const deptAddr = (d: string) => `dept:${d}`;

export function backoffMs(attempt: number, baseMs = 1000, maxMs = 60_000): number {
  const exp = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

export function dayStart(ts = Date.now(), tzOffsetMinutes = 480): number {
  // 以北京时间零点为日界
  const shifted = ts + tzOffsetMinutes * 60_000;
  return shifted - (shifted % 86_400_000) - tzOffsetMinutes * 60_000;
}
