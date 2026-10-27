# pi agent framework: research notes (verified 2026-10-26)

Sources: the packages were installed from npm into a scratch dir, and this report is based on their `.d.ts` files, READMEs, `docs/` and compiled JS, plus real calls against OpenCode Go. Code from memory was not used.

The throwaway test scripts used for verification (`test-ai.mjs`, `test-agent.mjs`, `smoke.mjs`, `test-custom.mjs`, `test-compact.mjs`, `list-go.mjs`) are not included in this repo.

---

## 0. Package names and versions (IMPORTANT: the scope changed)

| Package | Latest | Status |
|---|---|---|
| `@earendil-works/pi-ai` | **1.4.0** | current |
| `@earendil-works/pi-agent-core` | **1.4.0** | current |
| `@earendil-works/pi-coding-agent` | **1.4.0** | current |
| `@mariozechner/pi-ai` / `-agent-core` / `-coding-agent` | 0.73.1 | **deprecated** ("please use @earendil-works/... instead going forward") |

- The repo moved to **github.com/earendil-works/pi** (monorepo with `packages/ai`, `packages/agent`, `packages/coding-agent`).
- All packages are **ESM only** (`"type": "module"`) and need **Node >= 22.19.0**.
- Other packages pulled in: `pi-telemetry`, `pi-tui`, `pi-mcp`, `pi-codemode` (all 1.4.0).
- pi-ai 1.x **replaced the old global API** (`getModel()` / `stream()` / `complete()` as top-level functions) with a **`Models` collection** built from `createModels()` plus provider factories. The old API is still available from `@earendil-works/pi-ai/compat` but is slated for removal.

```bash
npm i @earendil-works/pi-ai @earendil-works/pi-agent-core
```

---

## 1. pi-ai

### 1.1 Getting a model (new API)

```ts
import { createModels } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

const models = createModels();                 // MutableModels
models.setProvider(opencodeGoProvider());      // register only what you need
const model = models.getModel("opencode-go", "deepseek-v4.1-flash"); // Model<Api> | undefined
```

Other ways to get one:
- `import { builtinModels } from "@earendil-works/pi-ai/providers/all"` registers every built-in provider (heavier).
- `getBuiltinModel(provider, id)` from `providers/all` is a static, literally-typed catalog read with no collection.
- `import { getModel } from "@earendil-works/pi-ai/compat"` is the legacy alias of `getBuiltinModel`.

Real signatures (`dist/models.d.ts`):

```ts
export declare function createModels(options?: CreateModelsOptions): MutableModels;
export interface CreateModelsOptions {
    credentials?: CredentialStore;
    modelsStore?: ModelsStore;
    authContext?: AuthContext;
    identity?: ClientIdentity;
}
export interface Models {
    getProviders(): readonly Provider[];
    getProvider(id: string): Provider | undefined;
    getModels(provider?: string): readonly Model<Api>[];
    getModel(provider: string, id: string): Model<Api> | undefined;
    getAvailable(providerId?: string, options?: AuthOperationOptions): Promise<readonly Model<Api>[]>;
    getAuth(providerId: string, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
    getAuth(model: AnyModel, overrides?: AuthResolutionOverrides): Promise<AuthResult | undefined>;
    refresh(options?: ModelsRefreshOptions): Promise<ModelsRefreshResult>;
    login(providerId: string, type: AuthType, interaction: AuthInteraction, options?: LoginOptions): Promise<Credential>;
    logout(providerId: string, options?: AuthOperationOptions): Promise<void>;
    stream<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): AssistantMessageEventStream;
    complete<TApi extends Api>(model: Model<TApi>, context: Context, options?: ModelsApiStreamOptions<TApi>): Promise<AssistantMessage>;
    streamSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): AssistantMessageEventStream;
    completeSimple(model: Model<Api>, context: Context, options?: ModelsSimpleStreamOptions): Promise<AssistantMessage>;
    // ...plus generateImages, classify, *OfType, deferred variants
}
export interface MutableModels extends Models {
    setProvider(provider: Provider): void;
    deleteProvider(id: string): void;
    clearProviders(): void;
}
export declare function createProvider<TApi extends Api = Api>(input: CreateProviderOptions<TApi>): Provider<TApi>;
export declare function hasApi<TApi extends Api>(model: AnyModel, api: TApi): model is Model<TApi>;
export declare function calculateCost(model: AnyModel, usage: Usage): Usage["cost"];
export declare function getSupportedThinkingLevels<TApi extends Api>(model: Model<TApi>): ModelThinkingLevel[];
export declare function clampThinkingLevel<TApi extends Api>(model: Model<TApi>, level: ModelThinkingLevel): ModelThinkingLevel;
```

The four call functions differ as follows:
- `stream` / `complete` take the API-specific options (`ApiStreamOptions<TApi>`, for example `OpenAICompletionsOptions`).
- `streamSimple` / `completeSimple` take the provider-neutral `SimpleStreamOptions`, including `reasoning: ThinkingLevel`, `toolChoice`, `thinkingBudgets` and `deferred`. **The Agent uses `streamSimple`.**

### 1.2 Model type (`dist/types.d.ts`)

```ts
export interface BaseModel<TApi extends string> {
    id: string;
    name: string;
    api: TApi;
    provider: ProviderId;
    baseUrl: string;
    input: ModelInputModality[];          // ("text" | "image")[]
    inputLimits?: ModelInputLimits;
    cost: ModelCost;                      // $ per 1M tokens
    headers?: Record<string, string>;
}
export interface Model<TApi extends Api> extends BaseModel<TApi> {
    type?: "chat";
    reasoning: boolean;
    thinkingLevelMap?: ThinkingLevelMap;  // pi level -> provider value; null = unsupported
    promptCache?: ModelPromptCache;
    contextWindow: number;
    maxTokens: number;
    samplingParams?: SamplingParams;
    samplingParamsByThinkingLevel?: SamplingParamsByThinkingLevel;
    compat?: TApi extends "openai-completions" ? OpenAICompletionsCompat
           : TApi extends "openai-responses" | "azure-openai-responses" | "openai-codex-responses" ? OpenAIResponsesCompat
           : TApi extends "anthropic-messages" ? AnthropicMessagesCompat
           : TApi extends "bedrock-converse-stream" ? BedrockCompat
           : TApi extends "mistral-conversations" ? MistralConversationsCompat : never;
}
// ModelCost = { input; output; cacheRead; cacheWrite; tiers?: {input,output,cacheRead,cacheWrite,inputTokensAbove}[] }

export type KnownApi = "openai-completions" | "mistral-conversations" | "openai-responses" | "azure-openai-responses"
  | "openai-codex-responses" | "anthropic-messages" | "bedrock-converse-stream" | "google-generative-ai"
  | "google-vertex" | "pi-messages";
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";      // pi-ai SimpleStreamOptions.reasoning
export type ModelThinkingLevel = "off" | ThinkingLevel;                                   // agent-core ThinkingLevel is the same set
```

`KnownProvider` includes both **`"opencode"`** (OpenCode Zen) and **`"opencode-go"`** (OpenCode Go).

### 1.3 Defining a custom or OpenAI-compatible model by hand (verified working)

In 1.x a model must belong to a **provider** registered on the collection. You build that provider with `createProvider`.

```ts
import { createModels, createProvider, envApiKeyAuth, type Model } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

const model: Model<"openai-completions"> = {
  id: "deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash (manual)",
  api: "openai-completions", provider: "my-go",
  baseUrl: "https://opencode.ai/inference/go/v1",
  reasoning: true, input: ["text"],
  cost: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
  contextWindow: 1_000_000, maxTokens: 384_000,
  compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: "max_tokens",
            requiresReasoningContentOnAssistantMessages: true, thinkingFormat: "deepseek" },
};
const models = createModels();
models.setProvider(createProvider({
  id: "my-go",
  auth: { apiKey: envApiKeyAuth("My key", ["MY_GO_KEY"]) },   // or: { apiKey: { name: "x", resolve: async () => ({ auth: { apiKey } }) } }
  models: [model],
  api: openAICompletionsApi(),       // or a map { "openai-completions": ..., "anthropic-messages": ... }
}));
```

- `compat` is auto-detected from `baseUrl` for known hosts. You only need to set it for unknown servers.
- Typical flags for Ollama/vLLM-style servers are `supportsDeveloperRole:false` and `supportsReasoningEffort:false`.
- The full list of `OpenAICompletionsCompat` fields is in the pi-ai README under "OpenAI Compatibility Settings".

You can also call an API implementation directly and skip the provider layer:

```ts
import { normalizeContext } from "@earendil-works/pi-ai";
import { stream } from "@earendil-works/pi-ai/api/openai-completions";
stream(model, normalizeContext(context), { apiKey: "..." });
```

### 1.4 API key resolution

- **Per request:** `options.apiKey` always wins, for example `models.completeSimple(model, ctx, { apiKey })`.
- **Provider auth:** each provider owns its own resolution. For `envApiKeyAuth(name, envVars)` the order is:
  1. a stored credential in the `CredentialStore` (`{ type: "api_key", key }`)
  2. the first env var that is set
- `createModels({ credentials })` takes a `CredentialStore`. The default is in-memory.
- pi-coding-agent ships `AuthStorage`, a `CredentialStore` backed by `auth.json` (`AuthStorage.create(path)`), and the helper `readStoredCredential(providerId, authPath?)`.
- **Env vars per provider:**

  | Provider | Env var |
  |---|---|
  | OpenAI | `OPENAI_API_KEY` |
  | Anthropic | `ANTHROPIC_API_KEY` or `ANTHROPIC_OAUTH_TOKEN` |
  | DeepSeek | `DEEPSEEK_API_KEY` |
  | Google | `GEMINI_API_KEY` |
  | OpenRouter | `OPENROUTER_API_KEY` |
  | Groq | `GROQ_API_KEY` |
  | xAI | `XAI_API_KEY` |
  | **OpenCode Zen and OpenCode Go** | **`OPENCODE_API_KEY`** |
  | Moonshot | `MOONSHOT_API_KEY` |
  | Kimi For Coding | `KIMI_API_KEY` |
  | ZAI | `ZAI_API_KEY` |
  | MiniMax | `MINIMAX_API_KEY` |

  The full table is in the pi-ai README under "Environment Variables".
- `options.env` (a `ProviderEnv`) provides per-request env overrides that take precedence over `process.env`.
- In pi-agent-core, `getApiKey(provider)` is called before each LLM call. The result is passed as `apiKey`.

### 1.5 Context, messages, Usage and cost

```ts
export interface Context { systemPrompt?: string; messages: Message[]; tools?: Tool[]; }
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;

export interface UserMessage { role: "user"; content: string | (TextContent | ImageContent)[]; timestamp: number; }
export interface SystemMessage {
    role: "system"; content: string | TextContent[];
    sections?: Record<string, string | null>; toolsAdded?: Tool[]; toolsRemoved?: ToolReference[]; timestamp: number;
}
export interface AssistantMessage {
    role: "assistant";
    content: (TextContent | ThinkingContent | ToolCall)[];
    api: Api; provider: ProviderId; model: string;
    responseModel?: string; responseId?: string;
    providerThinkingLevel?: string; thinkingLevel?: ModelThinkingLevel;
    diagnostics?: AssistantMessageDiagnostic[];
    usage: Usage;
    stopReason: StopReason;           // "pending"|"stop"|"length"|"toolUse"|"error"|"aborted"|"deferred"
    deferred?: DeferredHandle;
    errorMessage?: string; rawStopReason?: string; endTurn?: boolean;
    timestamp: number;                // request start, ms
    durationMs?: number;              // monotonic duration
}
export interface Usage {
    input: number; output: number; cacheRead: number; cacheWrite: number;
    cacheWrite1h?: number;
    reasoning?: number;               // subset of output
    totalTokens: number;
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; // USD
}
export interface ToolCall { type: "toolCall"; id: string; name: string; arguments: JsonObject; thoughtSignature?: string; namespace?: string; argumentsError?: string; }
// ToolResultMessage: { role:"toolResult"; toolCallId; toolName; content:(TextContent|ImageContent)[]; details?; usage?; nestedCalls?; isError:boolean; timestamp; durationMs? }
export interface Tool<TParameters extends TSchema = TSchema> {
    name: string; description: string; parameters: TParameters;
    constrainedSampling?: false | ConstrainedSamplingConfig;
}
```

Error handling:
- Request errors **never throw** from `stream` / `complete`. They come back as `stopReason: "error"` with `errorMessage` set, or as an `error` event.
- `stream()` returns an `AssistantMessageEventStream`. It is an async iterable of events, and `await s.result()` gives the final `AssistantMessage`.
- The event types are `start`, `text_start|delta|end`, `thinking_start|delta|end`, `toolcall_start|delta|end`, `done` and `error`.

Common `StreamOptions` fields:
- auth and transport: `apiKey`, `signal`, `headers`, `env`, `sessionId`
- sampling and caching: `temperature`, `maxTokens`, `samplingParams`, `cacheRetention`
- retries: `timeoutMs`, `maxRetries`, `maxRetryDelayMs`
- hooks: `onPayload`, `onResponse`, `onProviderStreamEvent`, `identity`, `metadata`, `telemetry`

Utilities:
- `validateToolCall(tools, toolCall)`
- `StringEnum([...])` (use it instead of `Type.Enum` for Google compatibility)
- `normalizeContext()`
- `getCurrentSystemMessage()` / `getCurrentSystemPrompt()` / `getCurrentTools()`
- `isContextOverflow(msg, contextWindow?)`
- `fauxProvider()` for tests

### 1.6 OpenCode Go provider (`opencode-go`): built in

Source: `dist/providers/opencode-go.js` and the catalog `dist/providers/data/opencode-go.json`.

```js
export function opencodeGoProvider() {
  return createProvider({
    id: "opencode-go", name: "OpenCode Go",
    auth: { apiKey: envApiKeyAuth("OpenCode API key", ["OPENCODE_API_KEY"]) },
    models: Object.values(OPENCODE_GO_MODELS),
    api: {   // mixed-API provider, dispatches on model.api
      "anthropic-messages":   withOpenCodeSessionHeader(anthropicMessagesApi()),
      "google-generative-ai": withOpenCodeSessionHeader(googleGenerativeAIApi()),
      "openai-completions":   withOpenCodeSessionHeader(openAICompletionsApi()),
      "openai-responses":     withOpenCodeSessionHeader(openAIResponsesApi()),
    },
  });
}
// withOpenCodeSessionHeader: if options.sessionId is set and no x-opencode-session header exists,
// it adds header "x-opencode-session: <sessionId>".
```

- **Import:** `import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go"`. There is also `opencodeProvider` (Zen) at `providers/opencode`.
- **Env var:** `OPENCODE_API_KEY`.
- **Base URLs:**
  - `https://opencode.ai/inference/go/v1` for the openai-completions, openai-responses and google models
  - `https://opencode.ai/inference/go` for the anthropic-messages models
- **GOTCHA (verified): you must pass `sessionId`.** Without it every request fails with:
  `400 {"type":"MissingSessionID","message":"Request is missing x-opencode-session ..."}`.
  - Pass `sessionId` in the stream options. The `Agent` constructor option `sessionId` covers this.
  - Alternatively, set `headers: { "x-opencode-session": id }` yourself.

#### OpenCode Go model catalog (pi-ai 1.4.0) with live smoke test

- The test asked each model once for a tool call, through `completeSimple` with a single `add(a, b)` tool, on 2026-10-26.
- Cost columns are USD per 1M tokens (input/output). "ctx" is the context window. "think levels" comes from `getSupportedThinkingLevels`.

| id | api | input | ctx | $/M in/out | think levels | live tool-call test |
|---|---|---|---|---|---|---|
| claude-haiku-5-5 | anthropic-messages | text+image | 1M | 0.1/0.5 | off..max | OK 2.1s |
| minimax-m3 | anthropic-messages | text+image | 1M | 0.3/1.2 | off..high | OK 1.7s |
| qwen3.7-plus | anthropic-messages | text+image | 1M | 0.4/1.6 | off..high | OK 2.5s |
| qwen3.8-flash | anthropic-messages | text+image | 1M | 0.15/0.47 | off..high | OK 2.3s |
| qwen3.8-max | anthropic-messages | text+image | 1M | 2/6 | off..high | OK 2.3s |
| gemini-4-argon-contributor | google-generative-ai | text+image | 1M | 4/20 | low,medium,high | **FAIL: ModelDeprecated** |
| beam-free | openai-completions | text | 1M | 0/0 | low..max | OK 1.3s |
| deepseek-v4-pro | openai-completions | text | 1M | 0.66/1.98 | off,high,max | OK 2.0s |
| **deepseek-v4.1-flash** | openai-completions | text+image | 1M | 0.15/0.6 | low,high,max (no "off") | **OK 1.9–4.2s** |
| glm-5.2 | openai-completions | text | 1M | 1.4/4.4 | high,max | OK 1.9s |
| glm-5.3 | openai-completions | text | 1M | 1.4/4.4 | low,high,max | OK 1.8s |
| glm-5.3-flash | openai-completions | text+image | 1M | 0.15/0.5 | low,high,max | OK 2.9s |
| hy3 | openai-completions | text | 256k | 0.14/0.58 | off,low,high | OK 2.8s |
| hy4-preview | openai-completions | text | 1.02M | 0.834/2.501 | off,high | OK 3.6s |
| kimi-k2.7-code | openai-completions | text+image | 262k | 0.95/4 | off..high | OK 2.1s |
| kimi-k3 | openai-completions | text+image | 1M | 3/15 | max only | OK 3.0s |
| longcat-2.0 | openai-completions | text | 1M | 0.3/1.2 | off..high | OK 3.1s |
| longcat-2.5-preview-free | openai-completions | text+image | 1M | 0/0 | off..high | **FAIL: 429 upstream unavailable** (may be transient) |
| mimo-v2.5 | openai-completions | text+image | 1M | 0.14/0.28 | off..high | OK 2.6s |
| mimo-v2.5-pro | openai-completions | text | 1M | 0.435/0.87 | off..high | **FAIL: Unsupported model** |
| mimo-v2.6-flash | openai-completions | text+image | 1M | 0.14/0.28 | off..high | OK 3.3s |
| mimo-v2.6-pro | openai-completions | text+image | 1M | 0.435/0.87 | off..high | OK 2.2s |
| minimax-m3.1-flash-free | openai-completions | text+image | 1M | 0/0 | low..max | **FAIL: ModelDeprecated (410)** |
| step-5-preview | openai-completions | text+image | 1M | 1/2.7 | low,medium,high | OK 1.7s |
| gpt-5.6-luna | openai-responses | text+image | 1.05M | 0.2/1.2 | low..max | OK 2.2s |
| gpt-6-luna | openai-responses | text+image | 1.05M | 0.1/0.5 | off,low..max | OK 2.7s |
| grok-4.7 | openai-responses | text+image | 500k | 2/6 | low..xhigh | OK 1.8s |
| muse-spark-1.2-contributor | openai-responses | text+image | 1M | 0.1/0.2 | minimal..xhigh | **FAIL: "trains on request data", account setting must allow it** |
| muse-spark-1.3-contributor | openai-responses | text+image | 1M | 0.1/0.2 | minimal..xhigh | **FAIL: same as above** |

**23 of 29 models work with this key, and tool calling works on every model that works at all.**

Suggested exam pool, balancing cost, speed and variety:
- `deepseek-v4.1-flash`, `qwen3.8-flash`, `glm-5.3-flash`, `mimo-v2.6-flash`, `gpt-6-luna`, `claude-haiku-5-5`, `minimax-m3`, `hy3`, `kimi-k2.7-code`, `deepseek-v4-pro`
- Use `beam-free` as a free option.

Thinking-level notes:
- `deepseek-v4.1-flash` has `thinkingLevelMap.off = null`, so "off" is not supported and is clamped to "low". It may still emit short thinking even when the Agent `thinkingLevel` is `"off"`.
- `clampThinkingLevel(model, level)` shows what a given level maps to.

---

## 2. pi-agent-core

```ts
import { Agent, type AgentTool, type AgentEvent, type AgentMessage } from "@earendil-works/pi-agent-core";
```

### 2.1 Constructor options (`dist/agent.d.ts`)

```ts
export type AgentInitialState = Partial<Omit<AgentState, "pendingToolCalls" | "isStreaming" | "streamingMessage" | "errorMessage">>;
export interface AgentOptions {
    initialState?: AgentInitialState;    // { systemPrompt, model, thinkingLevel, tools, messages }
    convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
    transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
    streamFn: StreamFn;                  // REQUIRED: models.streamSimple.bind(models)
    getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
    onPayload?: SimpleStreamOptions["onPayload"];
    onResponse?: SimpleStreamOptions["onResponse"];
    onProviderStreamEvent?: SimpleStreamOptions["onProviderStreamEvent"];
    beforeToolCall?: (context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>;
    afterToolCall?: (context: AfterToolCallContext, signal?: AbortSignal) => Promise<AfterToolCallResult | undefined>;
    finishTurn?: FinishTurn;
    prepareRequest?: PrepareRequest;
    prepareNextTurn?: (signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
    prepareNextTurnWithContext?: (context: PrepareNextTurnContext, signal?: AbortSignal) => Promise<AgentLoopTurnUpdate | undefined> | AgentLoopTurnUpdate | undefined;
    steeringMode?: QueueMode;            // "all" | "one-at-a-time" (default)
    followUpMode?: QueueMode;
    sessionId?: string;                  // forwarded to provider -> needed for opencode-go
    thinkingBudgets?: ThinkingBudgets;
    transport?: Transport;
    maxRetryDelayMs?: number;
    toolExecution?: ToolExecutionMode;   // "parallel" (default) | "sequential"
    identity?: ClientIdentity;           // default attribution = pi; pass { attribution: null } to send none
}
export type StreamFn = (model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions)
  => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
```

### 2.2 Methods and properties

```ts
class Agent {
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void; // listeners awaited in order
  get state(): AgentState;
  steeringMode / followUpMode (get/set)
  steer(message: AgentMessage): void;          // injected after current assistant turn + its tools finish
  followUp(message: AgentMessage): void;       // runs only after agent would otherwise stop
  clearSteeringQueue(); clearFollowUpQueue(); clearAllQueues();
  hasQueuedMessages(): boolean; peekQueuedMessages(): AgentMessage[];
  get signal(): AbortSignal | undefined;
  abort(): void;
  waitForIdle(): Promise<void>;                // resolves after agent_end listeners settle
  reset(): void;                               // keeps replayed system msg baseline, clears rest + queues
  prompt(message: AgentMessage | AgentMessage[]): Promise<void>;
  prompt(input: string, images?: ImageContent[]): Promise<void>;
  continue(): Promise<void>;                   // last msg must be user/toolResult (or uses queued input)
  // public mutable fields: convertToLlm, transformContext, streamFunction, getApiKey, beforeToolCall,
  // afterToolCall, finishTurn, prepareRequest, prepareNextTurn, sessionId, thinkingBudgets, transport,
  // maxRetryDelayMs, toolExecution, identity
}
```

- `prompt()` **throws** if a run is already active. Use `steer()` or `followUp()` while streaming, or `await agent.waitForIdle()` first.

### 2.3 State

```ts
export interface AgentState {
    readonly systemPrompt: string;     // replayed from transcript system messages (READ-ONLY)
    model: Model<any>;                 // settable: agent.state.model = other
    thinkingLevel: ThinkingLevel;      // "off"|"minimal"|"low"|"medium"|"high"|"xhigh"|"max"
    set tools(tools: AgentTool<any>[]); get tools(): AgentTool<any>[];
    set messages(messages: AgentMessage[]); get messages(): AgentMessage[];  // assignment copies top-level array
    readonly isStreaming: boolean;
    readonly streamingMessage?: AgentMessage;
    readonly pendingToolCalls: ReadonlySet<string>;
    readonly errorMessage?: string;
}
```

- **System prompt:**
  - `initialState.systemPrompt` (plus `tools`) is turned into a leading `{ role: "system", content, toolsAdded }` message, unless `initialState.messages[0]` is already a system message.
  - To change the prompt later, append a system message with `content` (extra instructions) or `sections` (named replacements).
  - Alternatively, rebuild the transcript with a new leading system message.
- **Model and thinking level:** assign `agent.state.model` and `agent.state.thinkingLevel` directly.
  - Inside the loop, `thinkingLevel` becomes `reasoning` (and `"off"` becomes `undefined`).
  - `prepareRequest` / `prepareNextTurn` can also swap the model or thinking level per request.
- **Tools:** assigning `agent.state.tools = [...]`:
  - is diffed against the declared tools before the next request
  - announces the change through an automatic system message

### 2.4 AgentTool (`dist/types.d.ts`)

```ts
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = any> extends Tool<TParameters> {
    label: string;                                     // UI label
    prepareArguments?: (args: unknown) => Static<TParameters>;
    outputSchema?: TSchema;
    execute: (toolCallId: string, params: Static<TParameters>, signal?: AbortSignal,
              onUpdate?: AgentToolUpdateCallback<TDetails>) => Promise<AgentToolResult<TDetails>>;
    replay?: "never" | "safe";
    executionMode?: ToolExecutionMode;
}
// inherited from pi-ai Tool: name, description, parameters (TypeBox schema), constrainedSampling?
export interface AgentToolResult<T = JsonValue | undefined> {
    content: (TextContent | ImageContent)[];   // what the model sees
    details: T;                                // structured data for UI/logs (persisted on ToolResultMessage.details)
    structuredContent?: JsonValue;
    usage?: Usage;
    isError?: boolean;                         // or just throw; thrown errors -> isError:true tool result
    terminate?: boolean;                       // skip follow-up LLM call if ALL results in batch terminate
}
```

- Arguments are validated against `parameters` before `execute` runs.
- `beforeToolCall` can return `{ block: true, reason, terminate? }`.
- `afterToolCall` can override `content`, `details`, `isError`, `usage` or `terminate`.

### 2.5 Events

```ts
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent } // assistant only
  | { type: "message_end"; message: AgentMessage }
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_update"; toolCallId: string; toolName: string; args: any; partialResult: any }
  | { type: "tool_execution_end"; toolCallId: string; toolName: string; result: any; isError: boolean; durationMs?: number };
```

This is the observed sequence for one tool call (from a real run):

`agent_start > turn_start > message_start > message_end (user) > message_start > message_end (assistant toolUse) > tool_execution_start > tool_execution_end > message_start > message_end (toolResult) > turn_end > turn_start > message_start > message_end (assistant) > turn_end > agent_end`

To stream text, handle `message_update` where `e.assistantMessageEvent.type === "text_delta"` and read `.delta`. To get usage per call, read `message_end` with `message.role === "assistant"`, then `message.usage`.

### 2.6 Message transformation pipeline

`AgentMessage[] -> transformContext(messages, signal) -> convertToLlm(messages) -> Message[] -> streamFn`

- **`convertToLlm`:**
  - The default keeps only the `system`, `user`, `assistant` and `toolResult` roles.
  - Override it when you add custom roles. Add them via declaration merging on `CustomAgentMessages` in `"@earendil-works/pi-agent-core"`.
- **`transformContext`:** an async hook for pruning or compaction **per request**. It does NOT mutate the stored state.
- **`prepareRequest({ context, model, thinkingLevel }, signal)`:** runs before every provider request. It can return `{ context, model, thinkingLevel }` replacements, which persist for the rest of the run.

### 2.7 Compaction

- **pi-agent-core has NO built-in compaction.** It only provides the hooks (`transformContext`, `prepareRequest`, `prepareNextTurn`).
- Compaction lives in pi-coding-agent (section 3).
- **Self-compaction by replacing messages (verified working):**

```ts
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
await agent.waitForIdle();
const sys = getCurrentSystemMessage(agent.state.messages);   // MUST keep: the system prompt lives in the transcript
agent.state.messages = [
  sys!,
  { role: "user", content: `<summary>${summary}</summary>`, timestamp: Date.now() },
  // optionally an assistant ack and/or the last N kept messages (never start the kept slice with a toolResult)
];
// agent.state.systemPrompt is preserved; the next prompt() sees only the compacted context.
```

  - In the test, the model recalled a fact that existed only in the injected summary.
  - **If you drop the system message, the system prompt is lost**, because `systemPrompt` is read-only and replayed from the messages.
  - For transient, per-request compaction, use `transformContext` instead.
- **Low-level API:**
  - `agentLoop(prompts, context, config, signal, streamFn)` and `agentLoopContinue(...)` return an `EventStream<AgentEvent, AgentMessage[]>`.
  - `runAgentLoop` / `runAgentLoopContinue` take an event sink instead.
  - `runToolCall(toolCall, options)` runs one tool call through the same validation and hook steps.
- **`streamProxy`** is available for browser-to-backend proxying.

---

## 3. pi-coding-agent

- **SDK:**
  - `createAgentSession(options?)` returns `Promise<{ session: AgentSession, extensionsResult, modelFallbackMessage? }>`.
  - Options: `cwd`, `agentDir`, `modelRuntime`, `model`, `thinkingLevel`, `scopedModels`, `noTools`, `tools`, `excludeTools`, `customTools: ToolDefinition[]`, `resourceLoader`, `sessionManager` (`SessionManager.inMemory()` for no files), `settingsManager`, `sessionStartEvent`.
  - `AgentSession` methods: `prompt`, `steer`, `followUp`, `abort`, `waitForIdle`, `subscribe`, `dispose`, `getLastAssistantText()`, `messages`, `model`, `systemPrompt`.
  - It brings the whole coding-agent stack: file and bash tools, resource discovery, `~/.pi/agent` settings and extensions. **For a non-coding app, pi-agent-core plus pi-ai directly is leaner.**
- **Compaction utilities** are exported from the package root:

  ```ts
  compact(preparation, model, apiKey, headers?, customInstructions?, signal?, thinkingLevel?, streamFn?, env?, retry?, callbacks?, sessionId?): Promise<CompactionResult>
  prepareCompaction(pathEntries: SessionEntry[], settings: CompactionSettings): CompactionPreparation | undefined
  generateSummary(currentMessages: AgentMessage[], model, _reserveTokens, apiKey, headers?, signal?, customInstructions?, previousSummary?, thinkingLevel?, streamFn?, env?, retry?, callbacks?, sessionId?): Promise<string>
  generateSummaryWithUsage(...same...): Promise<{ text: string; usage: Usage }>
  serializeConversation(messages: Message[]): string     // "[User]: ...\n[Assistant]: ...\n[Assistant tool calls]: ...\n[Tool result]: ..." (tool results truncated to 2000 chars)
  convertToLlm(...)                                       // coding-agent's AgentMessage -> Message
  estimateTokens(message: AgentMessage): number           // chars/4 heuristic
  shouldCompact(contextTokens, contextWindow, settings): boolean   // contextTokens > contextWindow - reserveTokens
  findCutPoint(entries, startIndex, endIndex, keepRecentTokens): CutPointResult
  calculateContextTokens(usage: Usage): number
  DEFAULT_COMPACTION_SETTINGS = { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 }
  ```

  - `generateSummary` works on plain `AgentMessage[]` with no session needed. **Pass `streamFn`, `apiKey` and `sessionId` explicitly.** Without `streamFn` it falls back to `getDefaultStreamFn()`, which throws unless `setDefaultStreamFn()` was called.
  - The summary format uses these headings: Goal, Constraints & Preferences, Progress (Done / In Progress / Blocked), Key Decisions, Next Steps, Critical Context.
- **Session JSONL** (`~/.pi/agent/sessions/--<cwd-path>--/<ISO-ts>_<uuid>.jsonl`, version 3, a tree via `id` / `parentId`):

  ```json
  {"type":"session","version":3,"id":"uuid","timestamp":"ISO","cwd":"/path"}
  {"type":"model_change","id":"8hex","parentId":null,"timestamp":"ISO","provider":"opencode-go","modelId":"..."}
  {"type":"thinking_level_change","id":"...","parentId":"...","timestamp":"ISO","thinkingLevel":"high"}
  {"type":"message","id":"...","parentId":"...","timestamp":"ISO","message":{ /* AgentMessage: system|user|assistant|toolResult|custom */ }}
  {"type":"compaction","id":"...","parentId":"...","timestamp":"ISO","summary":"...","firstKeptEntryId":"...","tokensBefore":50000,"systemMessage":{...},"usage":{...},"details":{...}}
  ```

  - Other entry types: `context_edit`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info`, `usage`.
  - The real local session files match this format. Their shapes were checked without printing any content.
- **Extensions:**
  - An extension is a TS module that exports `default function (pi: ExtensionAPI)`. It loads from `~/.pi/agent/extensions/` or `.pi/extensions/`, or via `--extension`.
  - It can call `pi.registerCommand`, register tools and providers, and use `pi.on(event, handler)`.
  - Events include `session_start`, `session_before_compact`, `session_compact_failed`, `session_before_tree`, `before_agent_start`, `agent_before_settle` and `turn_end`.
  - A `session_before_compact` handler can return `{ cancel: true }` or `{ compaction: { summary, firstKeptEntryId, tokensBefore, usage?, details? } }`.

---

## 4. TypeBox

- Uses the **new `typebox` package (TypeBox 1.x), not `@sinclair/typebox`**. The dependency is pinned to exactly **`typebox@1.3.27`** in pi-ai, pi-agent-core and pi-coding-agent. The npm latest is 1.4.3.
- Recommended import: use the re-export from pi-ai so the instances are guaranteed to match.

  ```ts
  import { Type, type Static, type TSchema, StringEnum } from "@earendil-works/pi-ai";
  ```

  - If you import `from "typebox"` directly, pin `typebox@1.3.27` to avoid duplicate copies.

---

## 5. Local pi auth and the verified OpenCode Go calls

- **`~/.pi/agent/auth.json` structure** (key redacted, length 51):

  ```json
  { "opencode-go": { "type": "api_key", "key": "<redacted>" } }
  ```

  - This is exactly pi-ai's `ApiKeyCredential` (`{ type: "api_key"; key?: string; env?: ProviderEnv }`), keyed by provider id.
  - pi resolves it through the `opencode-go` provider's `envApiKeyAuth`: the stored credential wins, then `OPENCODE_API_KEY`.
  - Base URL is `https://opencode.ai/inference/go/v1`. The api type depends on the model (see the table). `deepseek-v4.1-flash` uses **`openai-completions`**.
- **`~/.pi/agent/models-store.json`** only holds the dynamic-catalog cache. It has no secrets and is empty for opencode-go.

### 5.1 Working code: pi-ai, plain prompt plus tool call round trip (verified)

```js
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { createModels, Type } from "@earendil-works/pi-ai";
import { opencodeGoProvider } from "@earendil-works/pi-ai/providers/opencode-go";

const apiKey = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, "utf8"))["opencode-go"].key;
const models = createModels();
models.setProvider(opencodeGoProvider());
const model = models.getModel("opencode-go", "deepseek-v4.1-flash");
const sessionId = crypto.randomUUID();          // REQUIRED by OpenCode Go (x-opencode-session)

const r1 = await models.completeSimple(model, {
  systemPrompt: "You are terse.",
  messages: [{ role: "user", content: "Reply with exactly: pong", timestamp: Date.now() }],
}, { apiKey, sessionId });

const tools = [{ name: "add", description: "Add two integers and return the sum.",
                 parameters: Type.Object({ a: Type.Integer(), b: Type.Integer() }) }];
const ctx = { systemPrompt: "Always use the add tool for arithmetic.",
              messages: [{ role: "user", content: "What is 17 + 25? Use the tool.", timestamp: Date.now() }], tools };
const r2 = await models.completeSimple(model, ctx, { apiKey, sessionId });   // stopReason "toolUse"
ctx.messages.push(r2);
for (const b of r2.content) if (b.type === "toolCall")
  ctx.messages.push({ role: "toolResult", toolCallId: b.id, toolName: b.name,
    content: [{ type: "text", text: String(b.arguments.a + b.arguments.b) }], isError: false, timestamp: Date.now() });
const r3 = await models.completeSimple(model, ctx, { apiKey, sessionId });   // "17 + 25 = 42"
```

Measured results for `deepseek-v4.1-flash`:

| step | latency | stop | usage | cost (USD) |
|---|---|---|---|---|
| plain "pong" | 2330 ms | stop, text "pong" | in 41 / out 3 / reasoning 0 / total 44 | 0.00000795 |
| tool call 1 | 1944 ms | toolUse, `add({a:17,b:25})` | in 320 / out 53 / total 373 | 0.0000798 |
| tool result to answer | 1726 ms | stop, "17 + 25 = 42" | in 131 / out 8 / cacheRead 256 / total 395 | 0.0000252 |

### 5.2 Working code: pi-agent-core Agent with AgentTool (verified)

```js
import { Agent } from "@earendil-works/pi-agent-core";
const addTool = {
  name: "add", label: "Add", description: "Add two integers and return the sum.",
  parameters: Type.Object({ a: Type.Integer(), b: Type.Integer() }),
  execute: async (toolCallId, params, signal, onUpdate) => ({
    content: [{ type: "text", text: String(params.a + params.b) }],
    details: { a: params.a, b: params.b, sum: params.a + params.b },
  }),
};
const agent = new Agent({
  initialState: { systemPrompt: "You are terse. Always use the add tool for arithmetic.", model, thinkingLevel: "off", tools: [addTool] },
  streamFn: models.streamSimple.bind(models),
  getApiKey: () => apiKey,
  sessionId: crypto.randomUUID(),
  identity: { attribution: null },
});
agent.subscribe((e) => {
  if (e.type === "message_update" && e.assistantMessageEvent.type === "text_delta") process.stdout.write(e.assistantMessageEvent.delta);
  if (e.type === "message_end" && e.message.role === "assistant") console.log(e.message.usage);
});
await agent.prompt("What is 123 + 456?");
// state.messages roles: system,user,assistant,toolResult,assistant; final text "579"
```

Measured results:
- **Total time:** 3.9 s.
- **Turn 1:** 2.06 s, in 321 / out 70 (reasoning 17), $0.00009. It produced a toolCall `add(123, 456)`; the tool ran and returned `details {sum: 579}`.
- **Turn 2:** 1.79 s, in 148 / out 2 / cacheRead 256, $0.000024, answer "579".

### 5.3 Notes for the "exam" feature

- **Model choice:**
  - Use one `Models` collection with `opencodeGoProvider()` and choose by id with `models.getModel("opencode-go", id)`.
  - `models.getModels("opencode-go")` lists the whole catalog.
  - Run models in parallel with `Promise.all`. The smoke test did all 29 at once with no problem.
- **Session id:** give every conversation its own `sessionId`. It is required, and it also enables prompt caching (`cacheRead` showed up on the second turn).
- **Cost:** read cost from `AssistantMessage.usage.cost.total`, which pi-ai computes from the catalog prices. Sum it across `message_end` events.
- **Models to skip:** `gemini-4-argon-contributor`, `minimax-m3.1-flash-free`, `mimo-v2.5-pro` and `muse-spark-*` (deprecated, unsupported or blocked for this account), plus `longcat-2.5-preview-free` (upstream unavailable at test time).
