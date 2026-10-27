// 轻提示（右下角），成功/失败
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";

type Tone = "ok" | "bad" | "info";
interface ToastItem {
  id: number;
  text: string;
  tone: Tone;
}
const Ctx = createContext<(text: string, tone?: Tone) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setItems((xs) => [...xs.slice(-3), { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "bad" ? 6000 : 3200);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            <span className={`seal ${t.tone === "bad" ? "red" : t.tone === "ok" ? "jade" : "gold"}`} style={{ ["--seal-size" as string]: "22px" }}>
              <span>{t.tone === "bad" ? "驳" : t.tone === "ok" ? "准" : "知"}</span>
            </span>
            <span>{t.text}</span>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

export function useToast() {
  return useContext(Ctx);
}
