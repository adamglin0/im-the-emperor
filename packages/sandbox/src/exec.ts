// 命令执行：bash -lc，独立进程组（超时/取消时整组杀掉），输出各限 64KB，环境变量清洗。
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { constants as osConstants } from "node:os";
import type { ExecReq, ExecRes } from "@court/shared";
import { newId } from "@court/shared";
import { resolveInWorkspace, SandboxError, workspaceDir, workspaceIdentity } from "./paths.ts";

export const OUTPUT_CAP = 64 * 1024;
export const DEFAULT_TIMEOUT_S = 120;
export const MAX_TIMEOUT_S = 600;
const KEEP_JOBS = 200;
const KILL_GRACE_MS = 2000;

interface Job {
  id: string;
  workspace: string;
  command: string;
  state: ExecRes["state"];
  exitCode?: number;
  stdout: Buffer[];
  stderr: Buffer[];
  outBytes: number;
  errBytes: number;
  truncated: boolean;
  startedAt: number;
  endedAt?: number;
  child?: ChildProcess;
  done: Promise<void>;
  timer?: NodeJS.Timeout;
}

function signalNumber(sig: NodeJS.Signals): number | undefined {
  return (osConstants.signals as Record<string, number>)[sig];
}

/** 清洗后的环境：不继承任何宿主变量（尤其密钥），HOME 指向工作区。 */
export function scrubbedEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: home,
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    TMPDIR: process.env.TMPDIR && process.platform === "darwin" ? process.env.TMPDIR : "/tmp",
    PYTHONDONTWRITEBYTECODE: "1",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
}

export class JobRunner {
  private jobs = new Map<string, Job>();

  constructor(
    private root: string,
    private maxRunning = Number(process.env.SANDBOX_MAX_JOBS) || 16,
  ) {}

  /** signal：前台执行时客户端断开 → 杀掉作业 */
  async exec(req: ExecReq, signal?: AbortSignal): Promise<ExecRes> {
    if (!req || typeof req.command !== "string" || !req.command.trim()) throw new SandboxError(400, "bad_request", "command 必填");
    if (req.command.length > 100_000) throw new SandboxError(413, "too_large", "command 过长（上限 100000 字符）");
    const running = [...this.jobs.values()].filter((j) => j.state === "running").length;
    if (running >= this.maxRunning) throw new SandboxError(429, "too_many_jobs", `同时运行的作业已达上限 ${this.maxRunning}，请等待或取消后台作业`);
    const ws = workspaceDir(this.root, req.workspace);
    const cwd = resolveInWorkspace(ws, req.cwd);
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new SandboxError(400, "bad_request", `工作目录不存在：${req.cwd}`);
    const timeoutS = Math.min(MAX_TIMEOUT_S, Math.max(0.1, Number(req.timeout_seconds) || DEFAULT_TIMEOUT_S));

    const job = this.start(req.workspace, req.command, cwd, ws, timeoutS);
    if (req.background) return this.view(job);
    const onAbort = () => this.killGroup(job, "killed");
    signal?.addEventListener("abort", onAbort, { once: true });
    await job.done;
    signal?.removeEventListener("abort", onAbort);
    return this.view(job);
  }

  get(id: string): ExecRes {
    const job = this.jobs.get(id);
    if (!job) throw new SandboxError(404, "not_found", `没有作业 ${id}（只保留最近 ${KEEP_JOBS} 个）`);
    return this.view(job);
  }

  async cancel(id: string): Promise<ExecRes> {
    const job = this.jobs.get(id);
    if (!job) throw new SandboxError(404, "not_found", `没有作业 ${id}`);
    if (job.state === "running") {
      this.killGroup(job, "killed");
      await job.done;
    }
    return this.view(job);
  }

  /** 关停：杀掉所有仍在运行的作业 */
  async shutdown(): Promise<void> {
    const running = [...this.jobs.values()].filter((j) => j.state === "running");
    for (const j of running) this.killGroup(j, "killed");
    await Promise.all(running.map((j) => j.done));
  }

  private start(workspace: string, command: string, cwd: string, home: string, timeoutS: number): Job {
    const job: Job = {
      id: newId("job"),
      workspace,
      command,
      state: "running",
      stdout: [],
      stderr: [],
      outBytes: 0,
      errBytes: 0,
      truncated: false,
      startedAt: Date.now(),
      done: Promise.resolve(),
    };
    job.done = new Promise<void>((resolve) => {
      let child: ChildProcess;
      try {
        // 隔离模式：以工作区专属 uid 运行（看不到服务进程环境、杀不了服务、进不了别的工作区）
        const id = workspaceIdentity(workspace);
        child = spawn("bash", ["-lc", command], { cwd, env: scrubbedEnv(home), detached: true, stdio: ["ignore", "pipe", "pipe"], ...(id ?? {}) });
      } catch (e) {
        job.state = "error";
        job.stderr.push(Buffer.from(`无法启动 bash：${(e as Error).message}`));
        job.endedAt = Date.now();
        return resolve();
      }
      job.child = child;
      child.stdout!.on("data", (b: Buffer) => this.capture(job, "stdout", b));
      child.stderr!.on("data", (b: Buffer) => this.capture(job, "stderr", b));
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        job.endedAt = Date.now();
        job.child = undefined;
        resolve();
      };
      child.on("exit", (code, signal) => {
        if (job.timer) clearTimeout(job.timer);
        if (job.state === "running") job.state = "done";
        job.exitCode = code ?? (signal ? 128 + (signalNumber(signal) ?? 0) : undefined);
        // 主进程已退出，组内残留的后台子进程会占住管道：整组清理，之后 close 才会到来
        this.signalGroup(job, "SIGKILL");
        setTimeout(() => {
          child.stdout?.destroy();
          child.stderr?.destroy();
          finish();
        }, 3000).unref();
      });
      child.on("close", finish);
      child.on("error", (e) => {
        if (job.timer) clearTimeout(job.timer);
        if (job.state === "running") job.state = "error";
        job.stderr.push(Buffer.from(String(e.message)));
        setTimeout(finish, 100).unref();
      });
      job.timer = setTimeout(() => this.killGroup(job, "timeout"), timeoutS * 1000);
    });
    this.jobs.set(job.id, job);
    this.evict();
    return job;
  }

  private capture(job: Job, which: "stdout" | "stderr", b: Buffer): void {
    const used = which === "stdout" ? job.outBytes : job.errBytes;
    const room = OUTPUT_CAP - used;
    if (room <= 0) {
      job.truncated = true;
      return;
    }
    const piece = b.length > room ? b.subarray(0, room) : b;
    if (b.length > room) job.truncated = true;
    job[which].push(piece);
    if (which === "stdout") job.outBytes += piece.length;
    else job.errBytes += piece.length;
  }

  private killGroup(job: Job, state: "timeout" | "killed"): void {
    if (job.state !== "running") return;
    job.state = state;
    this.signalGroup(job, "SIGTERM");
    setTimeout(() => this.signalGroup(job, "SIGKILL"), KILL_GRACE_MS).unref();
  }

  private signalGroup(job: Job, sig: NodeJS.Signals): void {
    const pid = job.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      /* 进程组已不存在 */
    }
  }

  private evict(): void {
    if (this.jobs.size <= KEEP_JOBS) return;
    for (const [id, j] of this.jobs) {
      if (this.jobs.size <= KEEP_JOBS) break;
      if (j.state !== "running") this.jobs.delete(id);
    }
  }

  private view(job: Job): ExecRes {
    return {
      job_id: job.id,
      state: job.state,
      exit_code: job.exitCode,
      stdout: Buffer.concat(job.stdout).toString("utf8"),
      stderr: Buffer.concat(job.stderr).toString("utf8"),
      truncated: job.truncated,
      duration_ms: (job.endedAt ?? Date.now()) - job.startedAt,
    };
  }
}
