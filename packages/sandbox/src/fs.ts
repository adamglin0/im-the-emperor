// 工作区文件读写与列目录（限 2MB，路径限制在工作区内；最后一段不跟随符号链接）。
import { closeSync, constants, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, statSync, writeSync } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { giveToWorkspace, resolveInWorkspace, SandboxError, workspaceDir } from "./paths.ts";

export const FILE_CAP = 2 * 1024 * 1024;

function openNoFollow(file: string, flags: number, mode?: number): number {
  try {
    return openSync(file, flags | constants.O_NOFOLLOW, mode);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new SandboxError(403, "forbidden", "不允许经符号链接读写文件");
    if (code === "ENOENT") throw new SandboxError(404, "not_found", "文件不存在");
    if (code === "EISDIR") throw new SandboxError(400, "bad_request", "是目录，不是文件");
    if (code === "EACCES" || code === "EPERM") throw new SandboxError(403, "forbidden", "无权访问该文件");
    throw e;
  }
}

export function readWorkspaceFile(root: string, workspace: string, path: string): { content: string; encoding: "utf8" | "base64"; size: number } {
  if (!path) throw new SandboxError(400, "bad_request", "path 必填");
  const file = resolveInWorkspace(workspaceDir(root, workspace, false), path);
  const fd = openNoFollow(file, constants.O_RDONLY);
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new SandboxError(400, "bad_request", `不是普通文件：${path}`);
    if (st.size > FILE_CAP) throw new SandboxError(413, "too_large", `文件过大（${st.size} 字节，上限 ${FILE_CAP}）`);
    // 按上限读取，防止读取期间文件被换成无限流
    const buf = Buffer.alloc(Math.min(st.size, FILE_CAP));
    let n = 0;
    while (n < buf.length) {
      const r = readSync(fd, buf, n, buf.length - n, n);
      if (r <= 0) break;
      n += r;
    }
    const data = buf.subarray(0, n);
    const text = data.toString("utf8");
    const isText = Buffer.from(text, "utf8").equals(data) && !text.includes("\u0000");
    return isText ? { content: text, encoding: "utf8", size: n } : { content: data.toString("base64"), encoding: "base64", size: n };
  } finally {
    closeSync(fd);
  }
}

export function writeWorkspaceFile(root: string, req: { workspace: string; path: string; content: string; encoding?: "utf8" | "base64" }): { ok: true; size: number } {
  if (!req?.path) throw new SandboxError(400, "bad_request", "path 必填");
  if (typeof req.content !== "string") throw new SandboxError(400, "bad_request", "content 必须是字符串");
  const buf = Buffer.from(req.content, req.encoding === "base64" ? "base64" : "utf8");
  if (buf.length > FILE_CAP) throw new SandboxError(413, "too_large", `内容过大（${buf.length} 字节，上限 ${FILE_CAP}）`);
  const ws = workspaceDir(root, req.workspace);
  const file = resolveInWorkspace(ws, req.path);
  if (file === ws) throw new SandboxError(400, "bad_request", "不能写入工作区根目录");
  // 逐级创建缺失目录并交给工作区 uid
  const parent = dirname(file);
  if (!existsSync(parent)) {
    let cur = ws;
    for (const seg of relative(ws, parent).split(sep)) {
      cur = `${cur}${sep}${seg}`;
      if (!existsSync(cur)) {
        mkdirSync(cur);
        giveToWorkspace(req.workspace, cur);
      }
    }
  }
  // 目录创建后再校验一次（防并发符号链接替换）
  const checked = resolveInWorkspace(ws, req.path);
  if (checked !== file) throw new SandboxError(403, "forbidden", "路径在写入过程中发生变化");
  const fd = openNoFollow(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC, 0o644);
  try {
    if (!fstatSync(fd).isFile()) throw new SandboxError(400, "bad_request", `不是普通文件：${req.path}`);
    let n = 0;
    while (n < buf.length) n += writeSync(fd, buf, n, buf.length - n);
  } finally {
    closeSync(fd);
  }
  giveToWorkspace(req.workspace, file);
  return { ok: true, size: buf.length };
}

export function listWorkspaceDir(root: string, workspace: string, path = "."): { name: string; type: "file" | "dir"; size: number }[] {
  let ws: string;
  try {
    ws = workspaceDir(root, workspace, false);
  } catch (e) {
    // 尚未使用过的工作区：根目录视为空
    if (e instanceof SandboxError && e.status === 404 && (path === "." || path === "" || path === "/")) return [];
    throw e;
  }
  const dir = resolveInWorkspace(ws, path);
  if (!existsSync(dir)) throw new SandboxError(404, "not_found", `目录不存在：${path}`);
  if (!statSync(dir).isDirectory()) throw new SandboxError(400, "bad_request", `不是目录：${path}`);
  return readdirSync(dir, { withFileTypes: true })
    .slice(0, 1000)
    .map((d) => {
      let size = 0;
      try {
        size = d.isFile() ? statSync(`${dir}/${d.name}`).size : 0;
      } catch {
        /* 悬空链接等 */
      }
      return { name: d.name, type: d.isDirectory() ? ("dir" as const) : ("file" as const), size };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
}
