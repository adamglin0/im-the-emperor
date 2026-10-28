// 长请求用的 fetch：全局 fetch（undici）默认 headersTimeout = 300s，等不到 broker 首次拉镜像后的测试结果。
// 这里用 node:http(s) 发请求，只受调用方 AbortSignal 限时；接口与 fetch 兼容（够 HttpClient 用）。
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

export const longFetch: typeof fetch = (input, init = {}) =>
  new Promise<Response>((resolve, reject) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const signal = init.signal ?? undefined;
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const req = send(url, { method: init.method ?? "GET", headers: init.headers as Record<string, string> | undefined }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("error", reject);
      res.on("end", () => {
        signal?.removeEventListener("abort", onAbort);
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
        const status = res.statusCode ?? 502;
        const noBody = status === 204 || status === 304;
        resolve(new Response(noBody ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? "", headers }));
      });
    });
    const onAbort = () => req.destroy(signal?.reason instanceof Error ? signal.reason : new Error("aborted"));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (e) => {
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });
    if (init.body != null) req.write(init.body as string);
    req.end();
  });
