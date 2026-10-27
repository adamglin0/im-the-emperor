// 模型键 "provider/model_id" → pi-ai Model 对象。
// 网关只信任 model.provider 与 model.id（用自己的模型表与密钥），这里的其余字段仅用于本地估算（上下文窗口等）。
import { createModels, type Api, type Model } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";
import { LIMITS, type ModelEntry } from "@court/shared";

const catalog = createModels();
catalog.setProvider(opencodeGoProvider());

export function splitModelKey(key: string): { provider: string; id: string } {
  const i = key.indexOf("/");
  if (i <= 0) return { provider: "custom", id: key };
  return { provider: key.slice(0, i), id: key.slice(i + 1) };
}

/** 构造官员所用模型。目录内的模型取目录定义；其余（自定义/未知）合成一个最小 Model。 */
export function resolveModel(key: string, entry?: ModelEntry): Model<Api> {
  const { provider, id } = splitModelKey(key);
  const known = catalog.getModel(provider, id);
  if (known) {
    return entry?.context_window ? { ...known, contextWindow: entry.context_window } : known;
  }
  return {
    id,
    name: entry?.name ?? id,
    provider,
    api: (entry?.api ?? "openai-completions") as Api,
    baseUrl: entry?.base_url ?? "",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: entry?.context_window ?? LIMITS.defaultContextWindow,
    maxTokens: 8192,
  };
}
