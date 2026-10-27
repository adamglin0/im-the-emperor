// JSON 展示：缩进 + 简单着色
import { useMemo } from "react";

function esc(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function JsonView({ value, maxHeight = 420 }: { value: unknown; maxHeight?: number }) {
  const html = useMemo(() => {
    let text: string;
    try {
      text = typeof value === "string" ? JSON.stringify(JSON.parse(value), null, 2) : JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    if (text === undefined) text = "undefined";
    return esc(text).replace(
      /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)/gi,
      (_m, str, colon, kw, num) => {
        if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
        if (kw) return `<span class="j-kw">${kw}</span>`;
        return `<span class="j-num">${num}</span>`;
      },
    );
  }, [value]);
  return <pre className="code-block json-view" style={{ maxHeight }} dangerouslySetInnerHTML={{ __html: html }} />;
}
