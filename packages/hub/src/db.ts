import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Row = Record<string, unknown>;

/**
 * 档案库：node:sqlite 单连接（Node 单线程 + 同步 API ⇒ 天然单写者）。
 * - WAL、busy_timeout、synchronous=NORMAL
 * - tx(fn)：同步事务；嵌套调用时复用外层事务（SAVEPOINT）。
 */
export class Db {
  readonly raw: DatabaseSync;
  private depth = 0;
  private stmts = new Map<string, ReturnType<DatabaseSync["prepare"]>>();

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=OFF;");
  }

  migrate(): void {
    const here = dirname(fileURLToPath(import.meta.url));
    // 打包后 schema.sql 与 main.js 同目录；开发态与 db.ts 同目录
    let sql: string;
    try {
      sql = readFileSync(join(here, "schema.sql"), "utf8");
    } catch {
      sql = readFileSync(join(here, "..", "schema.sql"), "utf8");
    }
    this.raw.exec(sql);
  }

  private stmt(sql: string) {
    let s = this.stmts.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.stmts.set(sql, s);
    }
    return s;
  }

  all<T = Row>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }
  get<T = Row>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }
  run(sql: string, ...params: SQLInputValue[]): { changes: number; lastInsertRowid: number } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  exec(sql: string): void {
    this.raw.exec(sql);
  }

  tx<T>(fn: () => T): T {
    const sp = `sp${this.depth}`;
    if (this.depth === 0) this.raw.exec("BEGIN IMMEDIATE");
    else this.raw.exec(`SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const r = fn();
      this.depth--;
      if (this.depth === 0) this.raw.exec("COMMIT");
      else this.raw.exec(`RELEASE ${sp}`);
      return r;
    } catch (e) {
      this.depth--;
      if (this.depth === 0) this.raw.exec("ROLLBACK");
      else this.raw.exec(`ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw e;
    }
  }

  /** 读取 data_json 列并解析 */
  getJson<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    const r = this.get<{ data_json: string }>(sql, ...params);
    return r ? (JSON.parse(r.data_json) as T) : undefined;
  }
  allJson<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.all<{ data_json: string }>(sql, ...params).map((r) => JSON.parse(r.data_json) as T);
  }

  backup(toPath: string): void {
    mkdirSync(dirname(toPath), { recursive: true });
    this.raw.exec(`VACUUM INTO '${toPath.replace(/'/g, "''")}'`);
  }

  close(): void {
    this.raw.close();
  }
}
