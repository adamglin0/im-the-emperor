// 受限网页抓取：仅 http/https；DNS 解析后拒绝私网/回环/链路本地等地址（连接时用已校验的 IP，防 DNS 重绑定）。
import { lookup as dnsLookup } from "node:dns";
import http from "node:http";
import https from "node:https";
import { BlockList, isIP, type LookupFunction } from "node:net";
import { SandboxError } from "./paths.ts";

export const FETCH_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_BYTES = 200 * 1024;
export const HARD_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 5;

const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blocked.addSubnet(net, prefix, "ipv4");
}
for (const [net, prefix] of [
  ["::", 96], // 含 ::、::1 与 IPv4 兼容地址（::7f00:1 = ::127.0.0.1）
  ["100::", 64],
  ["2002::", 16], // 6to4
  ["2001::", 32], // Teredo
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["2001:db8::", 32],
] as const) {
  blocked.addSubnet(net, prefix, "ipv6");
}

/** 地址是否属于禁止访问的网段（含 IPv4 映射的 IPv6）。 */
export function isBlockedAddress(addr: string): boolean {
  const fam = isIP(addr);
  if (fam === 4) return blocked.check(addr, "ipv4");
  if (fam === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    return blocked.check(addr, "ipv6");
  }
  return true;
}

/** 解析后逐个校验；连接只会用到校验过的地址。 */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = (addresses as unknown as { address: string; family: number }[]) ?? [];
    const bad = list.find((a) => isBlockedAddress(a.address));
    if (!list.length || bad) {
      const e = Object.assign(new Error(`禁止访问内网/本机地址：${hostname} → ${bad?.address ?? "无地址"}`), { code: "EBLOCKED" });
      return callback(e, "", 0);
    }
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

export interface FetchResult {
  status: number;
  content_type: string;
  text: string;
  truncated: boolean;
}

export async function guardedFetch(req: { url: string; max_bytes?: number }): Promise<FetchResult> {
  const maxBytes = Math.min(HARD_MAX_BYTES, Math.max(1, Number(req?.max_bytes) || DEFAULT_MAX_BYTES));
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  let url = parseUrl(req?.url);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await requestOnce(url, maxBytes, deadline);
    if (res.redirect) {
      let next: string;
      try {
        next = new URL(res.redirect, url).toString();
      } catch {
        throw new SandboxError(502, "fetch_failed", `重定向地址非法：${res.redirect.slice(0, 200)}`);
      }
      url = parseUrl(next);
      continue;
    }
    return res.result!;
  }
  throw new SandboxError(502, "too_many_redirects", `重定向超过 ${MAX_REDIRECTS} 次`);
}

function parseUrl(raw: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(String(raw ?? ""));
  } catch {
    throw new SandboxError(400, "bad_request", `URL 非法：${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SandboxError(400, "bad_request", `只允许 http/https：${url.protocol}`);
  if (url.username || url.password) throw new SandboxError(400, "bad_request", "URL 不得包含账号密码");
  // 字面 IP 不经过 DNS lookup，需要在这里直接校验
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host)) throw new SandboxError(403, "blocked", `禁止访问内网/本机地址：${host}`);
  return url;
}

function requestOnce(url: URL, maxBytes: number, deadline: number): Promise<{ redirect?: string; result?: FetchResult }> {
  return new Promise((resolve, reject) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return reject(new SandboxError(504, "timeout", `抓取超时（${FETCH_TIMEOUT_MS / 1000}s）`));
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method: "GET",
        lookup: guardedLookup,
        headers: { "user-agent": "court-sandbox/1.0 (+jiangzuojian)", accept: "text/html,text/plain,application/json,*/*;q=0.5" },
        timeout: remaining,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          clearTimeout(timer);
          res.resume();
          return resolve({ redirect: res.headers.location });
        }
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;
        res.on("data", (b: Buffer) => {
          if (truncated) return;
          const room = maxBytes - size;
          if (b.length > room) {
            chunks.push(b.subarray(0, room));
            size += room;
            truncated = true;
            done();
            res.destroy();
            return;
          }
          chunks.push(b);
          size += b.length;
        });
        let finished = false;
        const done = () => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          resolve({
            result: {
              status,
              content_type: String(res.headers["content-type"] ?? ""),
              text: Buffer.concat(chunks).toString("utf8"),
              truncated,
            },
          });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", (e) => (finished ? undefined : reject(new SandboxError(502, "fetch_failed", `读取响应失败：${e.message}`))));
      },
    );
    const timer = setTimeout(() => req.destroy(new Error("timeout")), remaining);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      if (e.code === "EBLOCKED") return reject(new SandboxError(403, "blocked", e.message));
      if (e.message === "timeout") return reject(new SandboxError(504, "timeout", `抓取超时（${FETCH_TIMEOUT_MS / 1000}s）`));
      reject(new SandboxError(502, "fetch_failed", `抓取失败：${e.message}`));
    });
    req.end();
  });
}
