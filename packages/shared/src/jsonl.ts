import { appendFileSync, mkdirSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const SECRET_RE = /(sk-[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._-]{16,}|api[_-]?key["'\s:=]+[A-Za-z0-9._-]{16,})/gi;

export function redact(s: string): string {
  return s.replace(SECRET_RE, "［已脱敏］");
}

/** 按日轮转的 JSONL 日志：<dir>/YYYY-MM-DD.jsonl */
export class JsonlLog {
  constructor(
    private dir: string,
    private retentionDays = 30,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  private fileFor(ts: number): string {
    const d = new Date(ts + 8 * 3600_000).toISOString().slice(0, 10);
    return join(this.dir, `${d}.jsonl`);
  }

  write(rec: Record<string, unknown>): void {
    const ts = typeof rec.ts === "number" ? rec.ts : Date.now();
    const line = redact(JSON.stringify({ ts, ...rec })) + "\n";
    const f = this.fileFor(ts);
    mkdirSync(dirname(f), { recursive: true });
    appendFileSync(f, line);
  }

  /** 读取某日（默认今天）最后 tail 行 */
  read(date?: string, tail = 200): Record<string, unknown>[] {
    const f = date ? join(this.dir, `${date}.jsonl`) : this.fileFor(Date.now());
    if (!existsSync(f)) return [];
    const lines = readFileSync(f, "utf8").split("\n").filter(Boolean);
    return lines.slice(-tail).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  }

  dates(): string[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(".jsonl", ""))
      .sort();
  }

  prune(): void {
    const cutoff = Date.now() - this.retentionDays * 86_400_000;
    for (const f of readdirSync(this.dir)) {
      const p = join(this.dir, f);
      if (f.endsWith(".jsonl") && statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  }
}
