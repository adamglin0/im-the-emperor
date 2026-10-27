// 印章：单/双字，朱/金/青/墨，可「盖印」动画
import type { CSSProperties } from "react";
import type { Tone } from "../lib/labels.ts";

export function Seal({
  text,
  tone = "red",
  size = 34,
  solid,
  rotate,
  stamp,
  title,
  className = "",
}: {
  text: string;
  tone?: Tone;
  size?: number;
  solid?: boolean;
  rotate?: number;
  stamp?: boolean;
  title?: string;
  className?: string;
}) {
  const style: CSSProperties = { ["--seal-size" as string]: `${size}px` };
  if (rotate !== undefined) (style as Record<string, string>)["--seal-rot"] = `${rotate}deg`;
  const two = text.length >= 2;
  return (
    <span className={`seal ${tone || "ink"} ${solid ? "solid" : ""} ${stamp ? "stamp-in" : ""} ${className}`} style={style} title={title} aria-label={title ?? text}>
      <span style={two ? { fontSize: size * 0.36, lineHeight: 1.05, writingMode: "vertical-rl", letterSpacing: 0 } : undefined}>{text}</span>
    </span>
  );
}
