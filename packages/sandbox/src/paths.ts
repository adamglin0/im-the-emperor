// 工作区路径安全：一切文件/命令都被限制在 <root>/<workspace> 之内（含符号链接逃逸检查）。
// 作业隔离：沙箱以 root 运行且配置 SANDBOX_JOB_UID_BASE 时，每个工作区一个独立 uid，目录 0700。
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const WORKSPACE_RE = /^[a-z_]+$/;

export class SandboxError extends Error {
  constructor(
    public status: 400 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 504,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** 工作区作业身份；undefined = 与服务同 uid（开发态/非 root） */
export function workspaceIdentity(workspace: string): { uid: number; gid: number } | undefined {
  const base = Number(process.env.SANDBOX_JOB_UID_BASE);
  if (!base || process.getuid?.() !== 0) return undefined;
  // FNV-1a，稳定映射到 [base, base+50000)
  let h = 0x811c9dc5;
  for (const ch of workspace) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const uid = base + (h % 50_000);
  return { uid, gid: uid };
}

/** 把新建的路径交给工作区 uid（隔离模式下） */
export function giveToWorkspace(workspace: string, path: string): void {
  const id = workspaceIdentity(workspace);
  if (id) chownSync(path, id.uid, id.gid);
}

function validateName(workspace: string): void {
  if (!WORKSPACE_RE.test(workspace ?? "")) throw new SandboxError(400, "bad_request", `工作区名非法：${workspace}（只允许小写字母与下划线）`);
}

/** 返回工作区根目录的真实路径；create=false 且不存在时 404。 */
export function workspaceDir(root: string, workspace: string, create = true): string {
  validateName(workspace);
  const dir = join(resolve(root), workspace);
  if (!existsSync(dir)) {
    if (!create) throw new SandboxError(404, "not_found", `工作区 ${workspace} 尚未创建`);
    mkdirSync(dir, { recursive: true });
    const id = workspaceIdentity(workspace);
    if (id) {
      chownSync(dir, id.uid, id.gid);
      chmodSync(dir, 0o700);
    }
  }
  return realpathSync(dir);
}

function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

function lexists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * 把工作区内相对路径解析为绝对路径；越界（含经符号链接越界、悬空链接）抛 403。
 * 返回的路径其「已存在部分」已解析为真实路径；最后一段若是符号链接，由调用方以 O_NOFOLLOW 打开拒绝。
 */
export function resolveInWorkspace(wsDir: string, p: string | undefined): string {
  const target = resolve(wsDir, p ?? ".");
  if (!isInside(wsDir, target)) throw new SandboxError(403, "forbidden", `路径越出工作区：${p}`);
  // 找到最近的「存在的」祖先（lstat：悬空链接也算存在），其真实路径必须仍在工作区内
  let probe = target;
  while (!lexists(probe) && probe !== wsDir) probe = dirname(probe);
  let real: string;
  try {
    real = realpathSync(probe);
  } catch (e) {
    throw new SandboxError(403, "forbidden", `路径无法解析（悬空或循环链接）：${p}（${(e as NodeJS.ErrnoException).code ?? "error"}）`);
  }
  if (!isInside(wsDir, real)) throw new SandboxError(403, "forbidden", `路径经符号链接越出工作区：${p}`);
  if (probe === target) return real;
  return join(real, relative(probe, target));
}
