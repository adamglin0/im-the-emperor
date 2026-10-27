import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { backoffMs, sleepMs } from "./util.ts";

/**
 * 磁盘持久的只追加 outbox：用于事件镜像、日志摘要、冗余用量等「无副作用、可重放」的数据。
 * 写入即 append 一行 JSON；后台批量发送，成功后截断。hub 侧按 uid 去重。
 */
export class Outbox<T extends { uid: string }> {
  private queue: T[] = [];
  private overflowSinceRewrite = 0;
  private running = false;
  private stopped = false;
  lastError?: string;
  lastFlushAt = 0;

  constructor(
    private file: string,
    private send: (batch: T[]) => Promise<void>,
    private opts: { batchSize?: number; maxItems?: number; intervalMs?: number } = {},
  ) {
    mkdirSync(dirname(file), { recursive: true });
    if (existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          this.queue.push(JSON.parse(line));
        } catch {
          /* 丢弃损坏行 */
        }
      }
      const max = this.opts.maxItems ?? 50_000;
      if (this.queue.length > max) {
        this.queue.splice(0, this.queue.length - max);
        this.persist();
      }
    }
  }

  get size(): number {
    return this.queue.length;
  }

  push(item: T): void {
    const max = this.opts.maxItems ?? 50_000;
    if (this.queue.length >= max) {
      this.queue.shift(); // 丢最旧，保护磁盘
      this.lastError = `outbox 溢出，已丢弃最旧条目（上限 ${max}）`;
      this.overflowSinceRewrite++;
    }
    this.queue.push(item);
    appendFileSync(this.file, JSON.stringify(item) + "\n");
    // 溢出期间文件仍在追加：每溢出 1000 条重写一次，使磁盘占用有界
    if (this.overflowSinceRewrite >= 1000) {
      this.overflowSinceRewrite = 0;
      this.persist();
    }
  }

  private persist(): void {
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, this.queue.map((q) => JSON.stringify(q)).join("\n") + (this.queue.length ? "\n" : ""));
    renameSync(tmp, this.file);
  }

  /** 串行化的 flush 链：后台循环与 stop() 可能同时 flush，不串行会重复发送并误删未发送条目 */
  private flushChain: Promise<unknown> = Promise.resolve();

  /** 发送一批；返回是否全部清空 */
  flushOnce(): Promise<boolean> {
    const run = this.flushChain.then(() => this.flushBatch());
    this.flushChain = run.catch(() => undefined);
    return run;
  }

  private async flushBatch(): Promise<boolean> {
    if (!this.queue.length) return true;
    const batch = this.queue.slice(0, this.opts.batchSize ?? 200);
    await this.send(batch);
    this.queue.splice(0, batch.length);
    this.persist();
    this.lastFlushAt = Date.now();
    this.lastError = undefined;
    return this.queue.length === 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    void (async () => {
      let attempt = 0;
      while (!this.stopped) {
        try {
          const empty = await this.flushOnce();
          attempt = 0;
          await sleepMs(empty ? (this.opts.intervalMs ?? 1000) : 50);
        } catch (e) {
          this.lastError = (e as Error).message;
          await sleepMs(backoffMs(attempt++, 1000, 30_000));
        }
      }
      this.running = false;
    })();
  }

  async stop(flushTimeoutMs = 5000): Promise<void> {
    this.stopped = true;
    const deadline = Date.now() + flushTimeoutMs;
    while (this.queue.length && Date.now() < deadline) {
      try {
        await this.flushOnce();
      } catch {
        break;
      }
    }
  }
}
