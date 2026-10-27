// 网关自己的模型表：只信任调用方给出的 provider + id，其余（baseUrl、api、价格、密钥）一律取自网关。
// 来源三类：pi 内置提供商（凭据存网关凭据库或环境变量）、设置页自定义提供商（providers.json）、
// config/models.yaml 的 provider: custom（旧式，只读）。
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createModels,
  createProvider,
  envApiKeyAuth,
  InMemoryCredentialStore,
  type Api,
  type ApiKeyAuth,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Provider,
  type ProviderStreams,
} from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import {
  loadModelsConfig,
  type CustomProviderModelSpec,
  type CustomProviderSpec,
  type GatewayModelInfo,
  type ModelsConfig,
  type ProviderInfo,
  type ProviderModelInfo,
} from "@court/shared";
import { resolveOpencodeKey } from "./auth.ts";
import { FileCredentialStore, keyHint } from "./credentials.ts";

export const CUSTOM_PROVIDER = "custom";

export const CUSTOM_APIS: Record<string, () => ProviderStreams> = {
  "openai-completions": openAICompletionsApi,
  "openai-responses": openAIResponsesApi,
  "anthropic-messages": anthropicMessagesApi,
  "google-generative-ai": googleGenerativeAIApi,
};

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PROVIDER_ID_RE = /^[a-z0-9][a-z0-9._-]{0,47}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
const MAX_CUSTOM_MODELS = 200;

/** 设置页自定义提供商的落盘形态（不含密钥；请求头值视同密钥，文件 0600、接口不回传） */
export type StoredCustomProvider = Omit<CustomProviderSpec, "api_key">;

export type AuthVerdict = { ok: true; apiKey?: string; source?: string } | { ok: false; error?: string };

export interface ModelCatalog {
  models: MutableModels;
  config?: ModelsConfig;
  credentials: CredentialStore;
  /** 按 provider + id 解析受信任模型（目录外 ID 在允许时按提供商推断构造） */
  resolve(provider: string, id: string): Model<Api> | undefined;
  /** 该模型能否鉴权；需要显式传入的密钥（旧式 custom、opencode auth.json、测试注入）放在 apiKey */
  authFor(model: Model<Api>): Promise<AuthVerdict>;
  /** models.yaml 模型池 + 可用性 */
  list(): Promise<GatewayModelInfo[]>;
  providers(): Promise<ProviderInfo[]>;
  provider(id: string): Promise<ProviderInfo | undefined>;
  providerModels(id: string): ProviderModelInfo[] | undefined;
  isListed(provider: string, id: string): boolean;
  saveCustom(spec: CustomProviderSpec): Promise<ProviderInfo>;
  deleteCustom(id: string): Promise<void>;
  /** 清除凭据库里的凭据（环境变量里的仍然有效） */
  logout(id: string): Promise<void>;
  /** 凭据/配置文件的加载错误（健康检查展示） */
  loadErrors(): string[];
}

type LegacyEntry = ModelsConfig["models"][number];

export function buildCustomModel(e: LegacyEntry): Model<Api> {
  const api = e.api ?? "openai-completions";
  if (!CUSTOM_APIS[api]) throw new Error(`models.yaml 自定义模型 ${e.model_id} 的 api「${api}」不受支持`);
  if (!e.base_url) throw new Error(`models.yaml 自定义模型 ${e.model_id} 缺少 base_url`);
  return {
    id: e.model_id,
    name: e.name ?? e.model_id,
    api,
    provider: CUSTOM_PROVIDER,
    baseUrl: e.base_url,
    reasoning: false,
    input: ["text"],
    cost: { ...ZERO_COST },
    contextWindow: e.context_window ?? 128_000,
    maxTokens: 16_384,
  } as Model<Api>;
}

function customProviderModel(spec: StoredCustomProvider, m: CustomProviderModelSpec): Model<Api> {
  return {
    id: m.id,
    name: m.name || m.id,
    api: spec.api,
    provider: spec.id,
    baseUrl: spec.base_url,
    reasoning: !!m.reasoning,
    input: m.input?.length ? m.input : ["text"],
    cost: { ...ZERO_COST },
    contextWindow: m.context_window ?? 128_000,
    maxTokens: m.max_tokens ?? 16_384,
  } as Model<Api>;
}

function customAuth(spec: StoredCustomProvider): ApiKeyAuth {
  const name = spec.name || spec.id;
  const headers = spec.headers && Object.keys(spec.headers).length ? { ...spec.headers } : undefined;
  return {
    name: `${name} API 密钥`,
    login: async (ia) => {
      const key = (await ia.prompt({ type: "secret", message: `请输入 ${name} 的 API 密钥${spec.keyless ? "（无鉴权服务可留空）" : ""}` })).trim();
      if (!key && !spec.keyless) throw new Error("API 密钥不能为空");
      return { type: "api_key", key: key || undefined };
    },
    resolve: async ({ credential }) => {
      if (credential?.key) return { auth: { apiKey: credential.key, headers }, source: "stored credential" };
      // 本地无鉴权服务（Ollama 等）也需要一个非空 key
      if (spec.keyless) return { auth: { apiKey: "none", headers }, source: "无需密钥" };
      return undefined;
    },
  };
}

export function buildCustomProvider(spec: StoredCustomProvider): Provider {
  const factory = CUSTOM_APIS[spec.api];
  if (!factory) throw new Error(`自定义提供商 ${spec.id} 的 api「${spec.api}」不受支持`);
  return createProvider({
    id: spec.id,
    name: spec.name || spec.id,
    baseUrl: spec.base_url,
    auth: { apiKey: customAuth(spec) },
    models: (spec.models ?? []).map((m) => customProviderModel(spec, m)),
    api: { [spec.api]: factory() },
  });
}

/** 校验并规范化自定义提供商；返回错误文本或规范化结果 */
export function normalizeCustomSpec(raw: CustomProviderSpec, reserved: ReadonlySet<string>): StoredCustomProvider | string {
  if (!raw || typeof raw !== "object") return "请求体须为自定义提供商定义";
  const id = String(raw.id ?? "").trim();
  if (!PROVIDER_ID_RE.test(id)) return "id 须为小写字母/数字开头，仅含 a-z 0-9 . _ -，最长 48";
  if (id === CUSTOM_PROVIDER || id === "mock" || id === "faux") return `id「${id}」为保留字`;
  if (reserved.has(id)) return `id「${id}」与 pi 内置提供商重名`;
  const api = String(raw.api ?? "").trim();
  if (!CUSTOM_APIS[api]) return `api 须为 ${Object.keys(CUSTOM_APIS).join(" / ")}`;
  const base = String(raw.base_url ?? "").trim().replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    return "base_url 不是合法网址";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return "base_url 须为 http(s) 网址";
  if (url.username || url.password) return "base_url 不得内嵌用户名或密码（请用 API 密钥或请求头）";
  const out: StoredCustomProvider = { id, api, base_url: base };
  const name = String(raw.name ?? "").trim();
  if (name) out.name = name.slice(0, 80);
  if (raw.headers != null) {
    if (typeof raw.headers !== "object" || Array.isArray(raw.headers)) return "headers 须为对象";
    const h: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.headers)) {
      if (!HEADER_NAME_RE.test(k)) return `请求头名「${k}」不合法`;
      if (/^(host|content-length|connection|transfer-encoding)$/i.test(k)) return `请求头「${k}」不可自定义`;
      if (typeof v !== "string" || /[\r\n]/.test(v) || v.length > 4096) return `请求头「${k}」的值不合法`;
      h[k] = v;
    }
    out.headers = h;
  }
  if (raw.models != null) {
    if (!Array.isArray(raw.models)) return "models 须为数组";
    if (raw.models.length > MAX_CUSTOM_MODELS) return `models 最多 ${MAX_CUSTOM_MODELS} 个`;
    const seen = new Set<string>();
    const models: CustomProviderModelSpec[] = [];
    for (const m of raw.models) {
      const mid = String(m?.id ?? "").trim();
      if (!mid || /\s/.test(mid) || mid.length > 128) return `模型 ID「${mid}」不合法`;
      if (seen.has(mid)) return `模型 ID「${mid}」重复`;
      seen.add(mid);
      const e: CustomProviderModelSpec = { id: mid };
      if (m.name) e.name = String(m.name).slice(0, 80);
      for (const k of ["context_window", "max_tokens"] as const) {
        if (m[k] == null || (m[k] as unknown) === "") continue;
        const n = Math.floor(Number(m[k]));
        if (!Number.isFinite(n) || n <= 0) return `模型 ${mid} 的 ${k} 须为正整数`;
        e[k] = n;
      }
      if (m.reasoning) e.reasoning = true;
      if (m.input?.includes("image")) e.input = ["text", "image"];
      models.push(e);
    }
    out.models = models;
  }
  out.allow_unlisted = raw.allow_unlisted !== false;
  if (raw.keyless) out.keyless = true;
  if (!out.allow_unlisted && !out.models?.length) return "不允许目录外模型时，至少要列出一个模型";
  return out;
}

function toModelInfo(m: Model<Api>): ProviderModelInfo {
  return {
    id: m.id,
    name: m.name,
    api: m.api,
    context_window: m.contextWindow,
    max_tokens: m.maxTokens,
    reasoning: !!m.reasoning,
    input: [...(m.input ?? ["text"])],
    cost: m.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : { ...ZERO_COST },
  };
}

/** 探测 provider 的 api-key 解析器会读哪些环境变量（只记名字，一律答「未设置」） */
const envVarCache = new Map<string, Promise<string[]>>();
function envVarsOf(p: Provider): Promise<string[]> {
  const hit = envVarCache.get(p.id);
  if (hit) return hit;
  const run = (async () => {
    const names: string[] = [];
    const resolve = p.auth.apiKey?.resolve;
    if (!resolve) return names;
    try {
      await resolve({
        ctx: {
          env: async (n: string) => {
            if (!names.includes(n)) names.push(n);
            return undefined;
          },
          fileExists: async () => false,
        },
        credential: undefined,
        signal: AbortSignal.timeout(2000),
      });
    } catch {
      /* 探测失败无妨 */
    }
    return names.slice(0, 8);
  })();
  envVarCache.set(p.id, run);
  return run;
}

function writeJson0600(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod */
  }
}

export interface ModelCatalogOptions {
  configDir?: string;
  /** 网关数据目录：凭据库与自定义提供商存于 <dataDir>/gateway/；缺省只在内存 */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** 测试注入：替换模型集合（如 fauxProvider） */
  models?: MutableModels;
  /** 测试注入：provider → API 密钥（优先于其他来源） */
  apiKeys?: Record<string, string>;
}

export function createModelCatalog(opts: ModelCatalogOptions = {}): ModelCatalog {
  const env = opts.env ?? process.env;
  const errors: string[] = [];
  const gwDir = opts.dataDir ? join(opts.dataDir, "gateway") : undefined;
  let credentials: CredentialStore;
  if (gwDir) {
    const store = new FileCredentialStore(join(gwDir, "credentials.json"));
    if (store.loadError) errors.push(store.loadError);
    credentials = store;
  } else credentials = new InMemoryCredentialStore();

  const models = opts.models ?? createModels({ credentials });
  let config: ModelsConfig | undefined;
  const cfgPath = opts.configDir ? join(opts.configDir, "models.yaml") : undefined;
  if (cfgPath && existsSync(cfgPath)) config = loadModelsConfig(cfgPath);

  const builtinIds = new Set<string>();
  if (!opts.models) {
    for (const p of builtinProviders()) {
      builtinIds.add(p.id);
      models.setProvider(p);
    }
  }

  // 旧式：models.yaml 的 provider: custom
  const legacyEntries = (config?.models ?? []).filter((m) => m.provider === CUSTOM_PROVIDER);
  const keyEnvById = new Map<string, string | undefined>();
  if (legacyEntries.length) {
    const legacyModels = legacyEntries.map((e) => {
      keyEnvById.set(e.model_id, e.key_env);
      return buildCustomModel(e);
    });
    const apis: Record<string, ProviderStreams> = {};
    for (const m of legacyModels) apis[m.api] ??= CUSTOM_APIS[m.api]();
    models.setProvider(
      createProvider({
        id: CUSTOM_PROVIDER,
        name: "Custom（models.yaml）",
        // 每次请求都显式传 apiKey，这里的 auth 只用于可用性判断
        auth: { apiKey: envApiKeyAuth("Custom API key", legacyEntries.flatMap((e) => (e.key_env ? [e.key_env] : []))) },
        models: legacyModels,
        api: apis,
      }),
    );
  }

  // 设置页自定义提供商
  const customFile = gwDir ? join(gwDir, "providers.json") : undefined;
  const customs = new Map<string, StoredCustomProvider>();
  if (customFile && existsSync(customFile)) {
    try {
      const raw = JSON.parse(readFileSync(customFile, "utf8")) as { providers?: StoredCustomProvider[] };
      for (const s of raw.providers ?? []) {
        const norm = normalizeCustomSpec(s, builtinIds);
        if (typeof norm === "string") {
          errors.push(`自定义提供商 ${s?.id ?? "?"} 无效：${norm}`);
          continue;
        }
        customs.set(norm.id, norm);
        models.setProvider(buildCustomProvider(norm));
      }
    } catch (e) {
      // JSON.parse 的报错会带文件开头片段（请求头值视同密钥），只报类别
      errors.push(`自定义提供商文件损坏：${e instanceof SyntaxError ? "JSON 解析失败" : (e as Error).message}`);
    }
  }
  const customFileBroken = errors.some((e) => e.startsWith("自定义提供商文件损坏"));
  const persistCustoms = () => {
    if (!customFile) return;
    if (customFileBroken) throw new Error(`${customFile} 损坏，为免覆盖拒绝写入`);
    writeJson0600(customFile, { providers: [...customs.values()] });
  };

  // 目录外模型：按提供商推断（只有接口单一的提供商才可推断）
  const inferred = new Map<string, Model<Api>>();
  const allowUnlisted = (p: Provider): boolean => {
    if (p.id === CUSTOM_PROVIDER) return false;
    const spec = customs.get(p.id);
    if (spec) return spec.allow_unlisted !== false;
    if (!builtinIds.has(p.id)) return false;
    const ms = p.getModels();
    return ms.length > 0 && new Set(ms.map((m) => m.api)).size === 1;
  };
  const infer = (p: Provider, id: string): Model<Api> | undefined => {
    if (!id || /\s/.test(id) || id.length > 128 || !allowUnlisted(p)) return undefined;
    const key = `${p.id}/${id}`;
    const hit = inferred.get(key);
    if (hit) return hit;
    const spec = customs.get(p.id);
    const m = spec
      ? customProviderModel(spec, { id })
      : ({ ...p.getModels()[0], id, name: id, reasoning: false, cost: { ...ZERO_COST } } as Model<Api>);
    if (inferred.size > 1000) inferred.clear();
    inferred.set(key, m);
    return m;
  };

  const resolve = (provider: string, id: string): Model<Api> | undefined => {
    const listed = models.getModel(provider, id);
    if (listed) return listed;
    const p = models.getProvider(provider);
    return p ? infer(p, id) : undefined;
  };

  const opencodeFallback = (provider: string): string | undefined =>
    provider === "opencode-go" || provider === "opencode" ? resolveOpencodeKey(env) : undefined;

  const legacyKey = (id: string): string | undefined => {
    const keyEnv = keyEnvById.get(id);
    return keyEnv ? env[keyEnv] : "none"; // 本地无鉴权服务（Ollama 等）也需要一个非空 key
  };

  const authFor = async (model: Model<Api>): Promise<AuthVerdict> => {
    const injected = opts.apiKeys?.[model.provider];
    if (injected) return { ok: true, apiKey: injected, source: "test" };
    if (model.provider === CUSTOM_PROVIDER) {
      const k = legacyKey(model.id);
      return k ? { ok: true, apiKey: k, source: "models.yaml" } : { ok: false };
    }
    try {
      const check = await models.checkAuth(model.provider);
      if (check) return { ok: true, source: check.source };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const fallback = opencodeFallback(model.provider);
    return fallback ? { ok: true, apiKey: fallback, source: "pi auth.json" } : { ok: false };
  };

  const info = async (p: Provider): Promise<ProviderInfo> => {
    const ms = p.getModels();
    const apis = [...new Set(ms.map((m) => m.api))];
    const bases = [...new Set(ms.map((m) => m.baseUrl).filter(Boolean))];
    const spec = customs.get(p.id);
    const kind: ProviderInfo["kind"] = p.id === CUSTOM_PROVIDER ? "legacy" : spec ? "custom" : "builtin";
    let configured = false;
    let source: string | undefined;
    if (opts.apiKeys?.[p.id]) {
      configured = true;
      source = "test";
    } else if (kind === "legacy") {
      configured = legacyEntries.some((e) => !!legacyKey(e.model_id));
      source = "models.yaml";
    } else {
      try {
        const check = await models.checkAuth(p.id);
        if (check) {
          configured = true;
          source = check.source;
        }
      } catch {
        /* 凭据库读失败：按未配置 */
      }
      if (!configured && opencodeFallback(p.id)) {
        configured = true;
        source = "pi auth.json";
      }
    }
    const cred = kind === "legacy" ? undefined : await credentials.read(p.id).catch(() => undefined);
    const out: ProviderInfo = {
      id: p.id,
      name: p.name,
      kind,
      base_url: p.baseUrl ?? (bases.length === 1 ? bases[0] : undefined),
      apis: spec ? [spec.api] : apis,
      model_count: ms.length,
      login_methods: kind === "legacy" ? [] : [...(p.auth.apiKey?.login ? (["api_key"] as const) : []), ...(p.auth.oauth ? (["oauth"] as const) : [])],
      configured,
      allow_unlisted: allowUnlisted(p),
    };
    if (source) out.source = source;
    if (cred) {
      out.credential =
        cred.type === "api_key"
          ? { type: "api_key", key_hint: keyHint(cred.key), env_names: cred.env ? Object.keys(cred.env) : undefined }
          : { type: "oauth", expires: cred.expires };
    }
    if (kind === "builtin") {
      const vars = await envVarsOf(p);
      if (vars.length) out.env_vars = vars;
    }
    if (p.refreshModels) out.dynamic = true;
    if (spec?.headers) out.header_names = Object.keys(spec.headers);
    if (spec?.keyless) out.keyless = true;
    return out;
  };

  return {
    models,
    config,
    credentials,
    resolve,
    authFor,
    loadErrors: () => [...errors],
    isListed: (provider, id) => !!models.getModel(provider, id),
    providerModels: (id) => {
      const p = models.getProvider(id);
      return p ? p.getModels().map(toModelInfo) : undefined;
    },
    providers: async () => {
      const all = models.getProviders().filter((p) => p.id !== "faux" || !!opts.models);
      return Promise.all(all.map(info));
    },
    provider: async (id) => {
      const p = models.getProvider(id);
      return p ? info(p) : undefined;
    },
    saveCustom: async (raw) => {
      const norm = normalizeCustomSpec(raw, builtinIds);
      if (typeof norm === "string") throw new CatalogError(400, norm);
      const prev = customs.get(norm.id);
      if (!prev && models.getProvider(norm.id)) throw new CatalogError(409, `提供商 ${norm.id} 已存在且不是自定义提供商`);
      const key = typeof raw.api_key === "string" ? raw.api_key.trim() : "";
      // 换了上游（协议/主机/端口）：已存的密钥与请求头不得悄悄发往新地址，须重新填写
      if (prev && new URL(prev.base_url).origin !== new URL(norm.base_url).origin) {
        if (raw.headers == null && prev.headers && Object.keys(prev.headers).length)
          throw new CatalogError(400, "更换上游地址须重新填写请求头（旧值不会发往新地址）");
        const cred = await credentials.read(norm.id);
        if (!key && cred?.type === "api_key" && cred.key)
          throw new CatalogError(400, "更换上游地址须重新填写 API 密钥（旧密钥不会发往新地址；无鉴权服务请先清除凭据）");
      }
      // 未提供 headers 视为不改（值不回传给前端，前端无从回填）
      if (raw.headers == null && prev?.headers) norm.headers = prev.headers;
      customs.set(norm.id, norm);
      try {
        persistCustoms();
      } catch (e) {
        if (prev) customs.set(norm.id, prev);
        else customs.delete(norm.id);
        throw e;
      }
      for (const k of [...inferred.keys()]) if (k.startsWith(`${norm.id}/`)) inferred.delete(k);
      models.setProvider(buildCustomProvider(norm));
      if (key) await credentials.modify(norm.id, async () => ({ type: "api_key", key }));
      return (await info(models.getProvider(norm.id)!))!;
    },
    deleteCustom: async (id) => {
      const prev = customs.get(id);
      if (!prev) throw new CatalogError(models.getProvider(id) ? 400 : 404, models.getProvider(id) ? `${id} 不是自定义提供商，不能删除` : `没有提供商 ${id}`);
      customs.delete(id);
      try {
        persistCustoms();
      } catch (e) {
        customs.set(id, prev);
        throw e;
      }
      models.deleteProvider(id);
      for (const k of [...inferred.keys()]) if (k.startsWith(`${id}/`)) inferred.delete(k);
      await credentials.delete(id);
    },
    logout: async (id) => {
      if (!models.getProvider(id)) throw new CatalogError(404, `没有提供商 ${id}`);
      await credentials.delete(id);
    },
    list: async () => {
      const pool = config?.models ?? [];
      return Promise.all(
        pool.map(async (e): Promise<GatewayModelInfo> => {
          const m = resolve(e.provider, e.model_id);
          return {
            key: `${e.provider}/${e.model_id}`,
            provider: e.provider,
            model_id: e.model_id,
            name: e.name ?? m?.name ?? e.model_id,
            api: m?.api ?? e.api ?? "unknown",
            context_window: m?.contextWindow ?? e.context_window ?? 0,
            max_tokens: m?.maxTokens ?? 0,
            reasoning: m?.reasoning ?? false,
            cost: m?.cost ? { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } : { ...ZERO_COST },
            available: !!m && (await authFor(m)).ok,
          };
        }),
      );
    },
  };
}

export class CatalogError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}
