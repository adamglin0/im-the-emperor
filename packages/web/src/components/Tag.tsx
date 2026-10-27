import type { ReactNode } from "react";
import type { EdictState, OfficialState, TaskState } from "@court/shared/types";
import { EDICT_STATE, OFFICIAL_STATE, TASK_STATE, type Tone } from "../lib/labels.ts";

export function Tag({ tone = "", children, outline, title }: { tone?: Tone; children: ReactNode; outline?: boolean; title?: string }) {
  return (
    <span className={`tag ${tone} ${outline ? "outline" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function EdictStateTag({ state }: { state: EdictState }) {
  const s = EDICT_STATE[state] ?? { label: state, tone: "" as Tone };
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

export function TaskStateTag({ state }: { state: TaskState }) {
  const s = TASK_STATE[state] ?? { label: state, tone: "" as Tone };
  return <Tag tone={s.tone}>{s.label}</Tag>;
}

export function OfficialStateTag({ state }: { state: OfficialState }) {
  const s = OFFICIAL_STATE[state] ?? { label: state, tone: "" as Tone, icon: "?" };
  const live = state === "thinking" || state === "tool";
  return (
    <Tag tone={s.tone}>
      <span className={`dot-state ${live ? "pulse" : ""}`} />
      {s.label}
    </Tag>
  );
}
