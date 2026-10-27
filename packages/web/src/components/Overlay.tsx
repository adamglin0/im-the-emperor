// 抽屉、弹窗、确认框
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

function useEsc(onClose: () => void) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
}

export function Drawer({
  open,
  onClose,
  title,
  head,
  width = 640,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  head?: ReactNode;
  width?: number;
  children: ReactNode;
}) {
  useEsc(onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <aside className="drawer" style={{ ["--drawer-w" as string]: `${width}px` }} role="dialog" aria-modal="true">
        <div className="drawer-head">
          {title && <h2 className="grow">{title}</h2>}
          {head}
          <button className="btn ghost icon" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </aside>
    </>,
    document.body,
  );
}

export function Modal({ open, onClose, title, width, children }: { open: boolean; onClose: () => void; title?: ReactNode; width?: number; children: ReactNode }) {
  useEsc(onClose);
  if (!open) return null;
  return createPortal(
    <>
      <div className="overlay" onClick={onClose} />
      <div className="modal" style={width ? { ["--modal-w" as string]: `${width}px` } : undefined} role="dialog" aria-modal="true">
        {title && <h2>{title}</h2>}
        {children}
      </div>
    </>,
    document.body,
  );
}

interface ConfirmReq {
  title: string;
  body?: ReactNode;
  okText?: string;
  danger?: boolean;
  resolve: (ok: boolean) => void;
}
const ConfirmCtx = createContext<(r: Omit<ConfirmReq, "resolve">) => Promise<boolean>>(async () => false);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<ConfirmReq | null>(null);
  const ask = useCallback((r: Omit<ConfirmReq, "resolve">) => new Promise<boolean>((resolve) => setReq({ ...r, resolve })), []);
  const close = (ok: boolean) => {
    req?.resolve(ok);
    setReq(null);
  };
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      <Modal open={!!req} onClose={() => close(false)} title={req?.title} width={440}>
        <div className="serif" style={{ marginBottom: 16 }}>
          {req?.body}
        </div>
        <div className="btn-row" style={{ justifyContent: "flex-end" }}>
          <button className="btn" onClick={() => close(false)}>
            且慢
          </button>
          <button className={`btn ${req?.danger ? "primary" : "gold"}`} onClick={() => close(true)} autoFocus>
            {req?.okText ?? "准"}
          </button>
        </div>
      </Modal>
    </ConfirmCtx.Provider>
  );
}

export function useConfirm() {
  return useContext(ConfirmCtx);
}
