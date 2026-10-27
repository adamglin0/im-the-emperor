// 模型池元数据（任命门槛等，取自 hub /api/models/meta）：全站一次取、模块级缓存。
import { useEffect, useState } from "react";
import type { ModelsMeta } from "@court/shared/api";
import { hub } from "./client.ts";

/** hub 不可达时的默认门槛（与 config/models.yaml 缺省一致） */
export const DEFAULT_FITNESS_THRESHOLD = 60;

let cached: ModelsMeta | undefined;
let inflight: Promise<ModelsMeta | undefined> | undefined;

function load(): Promise<ModelsMeta | undefined> {
  inflight ??= hub
    .modelsMeta()
    .then((m) => (cached = m))
    .catch(() => {
      inflight = undefined; // 失败下次再试
      return undefined;
    });
  return inflight;
}

export function useModelsMeta(): ModelsMeta | undefined {
  const [m, setM] = useState(cached);
  useEffect(() => {
    if (cached) return;
    let alive = true;
    void load().then((x) => alive && x && setM(x));
    return () => {
      alive = false;
    };
  }, []);
  return m;
}

export function useFitnessThreshold(): number {
  return useModelsMeta()?.fitness_threshold ?? DEFAULT_FITNESS_THRESHOLD;
}
