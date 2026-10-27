// 空态 / 加载 / 错误 / 查询包装
import type { ReactNode } from "react";
import { errorText } from "../api/client.ts";
import type { QueryResult } from "../hooks/useQuery.ts";
import { Seal } from "./Seal.tsx";

export function Empty({ text = "暂无", seal = "空", children }: { text?: ReactNode; seal?: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <Seal text={seal} tone="ink" size={30} />
      <div>{text}</div>
      {children}
    </div>
  );
}

export function Loading({ text = "研墨中" }: { text?: string }) {
  return (
    <div className="loading">
      <span className="brush" />
      {text}…
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="err-box" role="alert">
      <Seal text="误" tone="red" size={22} />
      <div className="grow">{errorText(error)}</div>
      {onRetry && (
        <button className="btn sm" onClick={onRetry}>
          重试
        </button>
      )}
    </div>
  );
}

/** 统一处理 initial/error/empty；有旧数据时出错仍显示旧数据 + 小错误条 */
export function QueryView<T>({
  q,
  children,
  empty,
  isEmpty,
  loadingText,
}: {
  q: QueryResult<T>;
  children: (data: T) => ReactNode;
  empty?: ReactNode;
  isEmpty?: (d: T) => boolean;
  loadingText?: string;
}) {
  if (q.initial) return <Loading text={loadingText} />;
  if (q.data === undefined) return q.error ? <ErrorBox error={q.error} onRetry={q.reload} /> : <Loading text={loadingText} />;
  const emptyNow = isEmpty ? isEmpty(q.data) : Array.isArray(q.data) && q.data.length === 0;
  return (
    <>
      {q.error !== undefined && <ErrorBox error={q.error} onRetry={q.reload} />}
      {emptyNow ? (empty ?? <Empty />) : children(q.data)}
    </>
  );
}
