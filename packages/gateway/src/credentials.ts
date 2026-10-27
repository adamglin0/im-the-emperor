// 网关凭据库：pi 的 CredentialStore 落盘实现（DATA_DIR/gateway/credentials.json，0600）。
// 每个 provider 一条凭据；写入按 provider 串行，整文件原子替换。绝不打印凭据。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

export class FileCredentialStore implements CredentialStore {
  private data = new Map<string, Credential>();
  private chains = new Map<string, Promise<unknown>>();
  /** 读文件失败的原因（文件损坏时不覆盖，保留原文件待人工处理） */
  loadError?: string;

  constructor(private file: string) {
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, Credential>;
      for (const [id, c] of Object.entries(raw ?? {})) if (c && (c.type === "api_key" || c.type === "oauth")) this.data.set(id, c);
    } catch (e) {
      // JSON.parse 的报错会带上文件开头的片段（可能含密钥），只报类别；该文本会进日志与 /health
      this.loadError = `凭据文件损坏：${e instanceof SyntaxError ? "JSON 解析失败" : (e as Error).message}`;
    }
  }

  async read(providerId: string): Promise<Credential | undefined> {
    const c = this.data.get(providerId);
    return c ? structuredClone(c) : undefined;
  }

  async list(): Promise<readonly CredentialInfo[]> {
    return [...this.data.entries()].map(([providerId, c]) => ({ providerId, type: c.type }));
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      // 文件损坏时先拒绝，免得 fn（如 OAuth 刷新、登录）已生效却只留在内存、重启即丢
      this.assertWritable();
      const cur = this.data.get(providerId);
      const next = await fn(cur ? structuredClone(cur) : undefined);
      if (next === undefined) return cur ? structuredClone(cur) : undefined;
      // 写盘失败（磁盘满等）仍保留内存中的新值：OAuth 刷新可能已轮换 refresh token，丢掉就只能重新登录
      this.data.set(providerId, next);
      this.persist();
      return structuredClone(next);
    });
  }

  delete(providerId: string): Promise<void> {
    return this.enqueue(providerId, async () => {
      if (!this.data.has(providerId)) return;
      this.assertWritable();
      this.data.delete(providerId);
      this.persist();
    });
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => undefined);
    this.chains.set(providerId, tail);
    void tail.then(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    return run;
  }

  private assertWritable(): void {
    if (this.loadError) throw new Error(`${this.loadError}；为免覆盖，拒绝写入（请检查 ${this.file}）`);
  }

  private persist(): void {
    this.assertWritable();
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.data), null, 2), { mode: 0o600 });
    renameSync(tmp, this.file);
    try {
      chmodSync(this.file, 0o600);
    } catch {
      /* 某些文件系统不支持 chmod */
    }
  }
}

/** 密钥提示：只露末 4 位（短密钥一律不露）。 */
export function keyHint(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.length >= 12 ? `…${key.slice(-4)}` : "…";
}
