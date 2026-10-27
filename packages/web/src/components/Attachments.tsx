// 陛下发言附件：粘贴 / 拖入 / 点选文件 → 存为朝廷资产（court，百官可读）→ 发言时附上资产 ID，官员以 asset_read 查阅。
import { useCallback, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { hub, errorText } from "../api/client.ts";
import { useToast } from "./Toast.tsx";
import { fmtBytes } from "../lib/format.ts";

/** 与 hub ASSET_MAX_BYTES 一致 */
const MAX_BYTES = 10 * 1024 * 1024;
/** 粘贴的长文本超过此长度自动转为附件（短文本照常粘进输入框） */
const PASTE_TEXT_AS_FILE = 4000;

export interface Attachment {
  key: string;
  name: string;
  size: number;
  state: "uploading" | "ready" | "failed";
  asset_id?: string;
  mime?: string;
}

function toBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ""));
    r.onerror = () => fail(r.error ?? new Error("读取文件失败"));
    r.readAsDataURL(file);
  });
}

function stamp(): string {
  const d = new Date(Date.now() + 8 * 3_600_000);
  return d.toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
}

/** 粘贴的截图没有像样的文件名 */
function nameOf(file: File, i: number): string {
  const n = file.name && file.name !== "image.png" ? file.name : "";
  if (n) return n;
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg").replace(/\+.*/, "") || "bin";
  return `粘贴-${stamp()}${i ? `-${i}` : ""}.${ext}`;
}

/** 附件引用：随发言正文送达，官员据此 asset_read */
export function attachmentRefs(list: Attachment[]): string {
  const ready = list.filter((a) => a.state === "ready" && a.asset_id);
  if (!ready.length) return "";
  return (
    "\n\n【附件】（asset_read 查阅）\n" +
    ready.map((a) => `- ${a.name}（${a.mime || "未知类型"}，${fmtBytes(a.size)}）asset_id: ${a.asset_id}`).join("\n")
  );
}

export function useAttachments(folder: string) {
  const [list, setList] = useState<Attachment[]>([]);
  const toast = useToast();
  const seq = useRef(0);

  const patch = (key: string, p: Partial<Attachment>) => setList((l) => l.map((a) => (a.key === key ? { ...a, ...p } : a)));

  const add = useCallback(
    (files: File[]) => {
      files.forEach((file, i) => {
        const name = nameOf(file, i);
        if (file.size > MAX_BYTES) {
          toast(`${name} 过大（${fmtBytes(file.size)}，上限 ${fmtBytes(MAX_BYTES)}）`, "bad");
          return;
        }
        const n = ++seq.current;
        const key = `att${n}`;
        setList((l) => [...l, { key, name, size: file.size, state: "uploading" }]);
        void (async () => {
          try {
            const a = await hub.putAsset({
              actor: "emperor",
              owner: "court",
              path: `${folder}/${stamp()}-${n}-${name.replace(/[\\/]/g, "_").slice(0, 200)}`,
              content: await toBase64(file),
              encoding: "base64",
              mime: file.type || undefined,
              visibility: "court",
            });
            patch(key, { state: "ready", asset_id: a.id, mime: a.mime });
          } catch (e) {
            patch(key, { state: "failed" });
            toast(`${name} 上传失败：${errorText(e)}`, "bad");
          }
        })();
      });
    },
    [folder, toast],
  );

  const remove = (key: string) => setList((l) => l.filter((a) => a.key !== key));
  const clear = () => setList([]);
  const uploading = list.some((a) => a.state === "uploading");

  /** textarea onPaste：有文件则收为附件；超长文本转为 .txt 附件 */
  const onPaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (files.length) {
      e.preventDefault();
      add(files);
      return;
    }
    const text = e.clipboardData.getData("text/plain");
    if (text.length > PASTE_TEXT_AS_FILE) {
      e.preventDefault();
      add([new File([text], `粘贴-${stamp()}.txt`, { type: "text/plain" })]);
      toast(`长文（${text.length} 字）已存为附件`, "ok");
    }
  };

  const [dragging, setDragging] = useState(false);
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes("Files")) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      setDragging(false);
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      add(Array.from(e.dataTransfer.files));
    },
  };

  return { list, add, remove, clear, uploading, onPaste, dropProps, dragging };
}

export function AttachButton({ onFiles }: { onFiles: (files: File[]) => void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className="btn ghost" title="附上文件（亦可粘贴或拖入）" onClick={() => input.current?.click()}>
        附件
      </button>
      <input
        ref={input}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          onFiles(Array.from(e.target.files ?? []));
          e.target.value = "";
        }}
      />
    </>
  );
}

export function AttachmentList({ list, onRemove }: { list: Attachment[]; onRemove: (key: string) => void }) {
  if (!list.length) return null;
  return (
    <div className="attach-list">
      {list.map((a) => (
        <span key={a.key} className={`attach-chip ${a.state}`} title={a.asset_id ?? a.name}>
          <span className="name">{a.name}</span>
          <span className="muted small">{a.state === "uploading" ? "上传中…" : a.state === "failed" ? "失败" : fmtBytes(a.size)}</span>
          <button type="button" aria-label={`移除 ${a.name}`} onClick={() => onRemove(a.key)}>
            ×
          </button>
        </span>
      ))}
    </div>
  );
}
