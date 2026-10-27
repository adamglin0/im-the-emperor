// Markdown 渲染：原始 HTML 一律转义（内容来自 Agent，视为不可信）
import { useMemo } from "react";
import { Marked } from "marked";

const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token) {
      const raw = typeof token === "string" ? token : token.text;
      return raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    },
    link(token) {
      const href = /^(https?:|\/|#)/.test(token.href) ? token.href : "#";
      const text = this.parser.parseInline(token.tokens);
      return `<a href="${href.replace(/"/g, "&quot;")}" target="_blank" rel="noreferrer noopener">${text}</a>`;
    },
    image(token) {
      return `<span class="muted">[图：${(token.text || "").replace(/</g, "&lt;")}]</span>`;
    },
  },
});

export function Markdown({ text, className = "" }: { text: string; className?: string }) {
  const html = useMemo(() => md.parse(text ?? "", { async: false }) as string, [text]);
  return <div className={`prose ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
