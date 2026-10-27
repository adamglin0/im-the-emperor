# 实施计划（Plan v1）

依据：`docs/design.md`（v1 设计）、`docs/research/pi-agent.md`（pi 实测 API）。
契约已就绪（任何模块不得擅改，确需修改须在报告中说明并保持向后兼容）：
- `packages/shared/src/types.ts` 领域模型；`api.ts` HTTP 契约 + HubClient/DeptClient/SandboxClient；`consts.ts` 安全阀；`tool-groups.ts` 工具组；`court-config.ts` 名册加载；`util.ts`/`jsonl.ts`/`outbox.ts` 工具库。
- `packages/hub/src/schema.sql` 档案库表结构；`db.ts` 数据库封装；`ctx.ts` hub 内部服务契约（HubCtx）。
- `packages/dept/src/tool-context.ts` 运行时↔工具契约。
- `config/court.yaml`、`config/models.yaml`。

技术栈：Node 24（ESM，TS 直接由 tsx 运行开发态，esbuild 打包生产）、TypeScript 7、hono + @hono/node-server、node:sqlite、`@earendil-works/pi-ai` / `pi-agent-core` 1.4.0（TypeBox 从 `@earendil-works/pi-ai` 导入 `Type`）、croner（cron）、vitest、React + Vite（Web）。
导入约定：包内相对导入带 `.ts` 后缀；跨包 `import ... from "@court/shared"`（Web 只能用 `@court/shared/types` 与 `@court/shared/api`，因为 index 里有 node 模块）。
代码风格：中文注释简洁；错误信息中文（会被 Agent 读到，要可操作）；不得引入原生编译依赖。

## 模块划分（并行）

| # | 模块 | 目录 | 负责 |
|---|---|---|---|
| A | hub 基础设施 | `packages/hub/src/{main,app,auth,seed}.ts`、`services/{registry,events,messages,notifications,approvals,idempotency,ledger,assets,schedules,doorbell}.ts`、`routes/{registry,messages,notifications,schedules,assets,ledger,config,personnel,events,emperor_core,live}.ts` | 启动、播种、鉴权/ACL、消息投递与限流、待办与审批、账本预算、资产、定时任务调度、门铃、SSE、皇帝核心接口（oral/halt/overview/resolve）、对部门实时数据代理（/api/live/:post/...）、静态 Web 托管 |
| B | hub 流程 | `services/{workflow,briefing,exams,audit,traces}.ts`、`routes/{deliberations,edicts,tasks,services,briefing,exams,audit,traces,emperor_flow}.ts` | 议事协议、诏令状态机、任务状态机、服务调用、看门狗、醒来简报、科举（题库/考场/阅卷/金榜）、稽查规则、追踪图、皇帝流程接口（council/edicts/edict action） |
| C | 部门运行时 | `packages/dept/src/{main,server,runtime,official,session,compaction,briefing-render,model,doorbell}.ts` | 官员主循环、pi Agent 集成（streamProxy→网关）、会话持久化与崩溃恢复、压缩、唤醒/等待/睡眠、心跳、cursor、outbox、部门/官员 API 门面 |
| D | 工具 | `packages/dept/src/tools/*.ts`、`tools/index.ts` | `TOOL_GROUPS` 中全部工具（TypeBox 参数、中文描述、调用 hub/部门/沙箱、输出截断、trace 聚焦、幂等键） |
| E | 网关+沙箱+部署 | `packages/gateway/src/*`、`packages/sandbox/src/*`、`Dockerfile`、`docker/sandbox.Dockerfile`、`scripts/{build,gen-compose}.mjs`、`docker-compose.yml`、`.env.example` | LLM 网关（/api/stream 兼容 streamProxy、/api/complete、限流熔断、预算检查、记账 outbox、mock 大脑）、沙箱执行器、镜像与编排 |
| F | Web | `packages/web/*` | 皇帝视角 UI（design §13 全部页面），诏令调查 DAG + 泳道，SSE 实时 |

集成与端到端测试由主控完成（`tests/`）。

## 关键跨模块约定

1. **身份**：每个部门一个 token（hub 播种时生成，存 `depts.token`；docker 环境变量 `DEPT_TOKEN` 由 compose 从 `data/hub/tokens.env` 注入——实现：hub 启动时把 tokens 写到 `DATA_DIR/hub/tokens.json`，dept 启动时若未配 `DEPT_TOKEN` 则读共享卷 `data/shared/tokens.json`（hub 写一份到该处）。网关 token、控制面 token、沙箱 token 同理（`GATEWAY_TOKEN`、`CONTROL_TOKEN`、`SANDBOX_TOKEN`，缺省时 hub 生成并写入 `data/shared/tokens.json`）。
2. **官员 API 门面**：dept 的 `POST /officials/:post/messages`、`/dept/inbox`、`/dept/services/:name`、`/officials/:post/services/:name` 把调用方的 `Authorization` 与 `X-Acting-Post` 原样转发给 hub 对应接口（hub 校验），成功后本地立即唤醒目标官员。
3. **门铃**：hub 提交后对相关部门 `POST http://<host>:8080/control/doorbell {posts}`（带 `CONTROL_TOKEN`），失败忽略（dept 每 30s 兜底拉取）。
4. **网关调用**：dept 用 `streamProxy(model, ctx, { proxyUrl: GATEWAY_URL, authToken: DEPT_TOKEN, sessionId, metadata: { post_id, official_id, dept, trace_id, turn_id, call_idx, purpose }, reasoning })`。网关以 token 识别部门、校验 `metadata.post_id` 属于该部门（从 hub `/api/internal/tokens` 与 registry 获取）。网关只信任 `model.provider` 与 `model.id`，用自己的模型表与密钥。
5. **醒来简报格式**（dept 渲染 → LLM/mock 大脑读取）：中文说明 + 机器可读块：
   ```
   <职事清单 json>
   [ ...PendingItem[] ... ]
   </职事清单>
   ```
   新消息正文另列在「新来信」部分（每条带 message_id、from、kind、subject、正文截断 1500 字）。
6. **mock 大脑**（网关 `LLM_MODE=mock`）：读取最后一条 user 消息中的 `<职事清单 json>`，按顺序为每个 item 生成恰好一次工具调用（统计最后一条 user 消息之后已有的 assistant toolCall 数作为游标），全部处理完调用 `end_turn`。映射表见 E 模块说明。若无清单（如超时自唤醒）直接 `end_turn`。压缩/阅卷/考试请求（`metadata.purpose`）返回固定文本。诏令标题含「测封驳」时，草稿 1 号被封驳一次。
7. **结束型工具**：`sleep`、`wait_for`、`end_turn` 返回 `terminate: true`；runtime 读取 ToolContext 记录的下一次唤醒条件。
8. **trace 传递**：runtime 在轮开始时设定 trace（唤醒消息的 trace，或新建 `tr_xxx`）；工具若带 `edict_id/task_id/message_id/request_id` 参数，先查到其 trace 再 `focusTrace`；所有对 hub 的写请求带 `trace_id`。
9. **事件**：dept 经 outbox 上报 `turn.start/turn.end/llm.call/tool.call/tool.error/wake/sleep/wait/compact/budget_block/error` 事件（带 span：turn 为 span，tool 为子 span；`trace_id` 为当轮 trace）；hub 自身对消息、诏令、任务、服务、定时、待办产生事件与 span。
10. **端口**：hub 8000、dept 8080、gateway 8100、sandbox 8200。环境变量：`DATA_DIR`（默认 `./data`）、`CONFIG_DIR`（默认 `./config`）、`HUB_URL`、`GATEWAY_URL`、`SANDBOX_URL`、`DEPT`、`LLM_MODE`、`PORT`。
11. **测试**：每模块自带 vitest 单测（`packages/<pkg>/test/*.test.ts`），不得调用真实 LLM；`npm test` 全绿；`npx tsc -p tsconfig.json --noEmit` 无错（web 有自己的 tsconfig）。

## 里程碑

1. M1 并行实现 A–F（各自单测通过）。
2. M2 主控集成：进程内端到端测试（mock）：议事→颁旨→起草→封驳→重拟→审核→分派→执行→核验→复奏→御览；定时任务触发；服务调用；预算熔断；罢朝；部门重启恢复。
3. M3 Docker 端到端（mock）：`docker compose up`，跑同一脚本；混沌：杀部门容器、停 hub 10s。
4. M4 真实模型冒烟（opencode-go/deepseek-v4.1-flash）：一道小圣旨完整走通；检查账本、日志、UI。
5. M5 UI 验收（浏览器截图巡检）、复审修复循环、文档（README 运行说明）。

## 运行时发现（模块 C）

1. **streamProxy 请求形状（已核对 pi-agent-core 1.4.0 `dist/proxy.js`）**：`POST ${GATEWAY_URL}/api/stream`，头 `Authorization: Bearer <DEPT_TOKEN>`，正文 `{ model, context, options }`；`options` 经 `buildProxyRequestOptions` 只保留 `temperature samplingParams maxTokens reasoning cacheRetention sessionId headers metadata transport thinkingBudgets maxRetryDelayMs`——**`metadata` 会原样转发**（网关读 `body.options.metadata`，即 `GatewayMeta`），无需 `x-court-meta` 头。`sessionId` 固定为 `ses_<official_id>`。响应为 SSE `data: <ProxyAssistantMessageEvent JSON>` 行，须以 `done` 或 `error` 事件结尾（否则客户端报「Connection closed by proxy server」）。
2. **网关错误约定（dept 运行时据此分流）**：非 2xx 响应时客户端得到 `errorMessage = "Proxy error: " + body.error`（无 `error` 字段则为 `Proxy error: <status> <statusText>`）；流内 `error` 事件的 `errorMessage` 原样传入。runtime 用子串匹配：含 `BUDGET_EXCEEDED` → 停俸（suspended，10 分钟后 `budgetCheck` 复查）；含 `HALTED` → 暂停；含 `CONTEXT_TOO_LONG`（或 pi-ai `isContextOverflow` 命中）→ 强制压缩重试一次；含 `CIRCUIT_OPEN`/`RATE_LIMITED`、网络错误或 `Proxy error: 429|5xx` → 抱恙（sick，1→2→4… 分钟退避，上限 30 分钟）；其余 → 记错、结束本轮、默认等待。**网关请在 `error` 文本开头放上述大写代码**（如 `{"error":"BUDGET_EXCEEDED: 门下省今日额度已用尽"}`）。
3. 压缩摘要走 `GatewayClient.complete`（`POST /api/complete`，`metadata.purpose = "compaction"`，`model_key` = 官员模型）；失败时退回机械截取，不阻塞。
4. 部门 runtime 发往 hub 的事件类型：`turn.start` `turn.end`（带 turn span）、`llm.call`、`tool.call`（带 tool 子 span）、`tool.error`、`turn.capped`、`sleep`、`wait`、`compact`、`budget_block`、`error`。
5. 运行入口：`packages/dept/src/main.ts` 导出 `startDept(opts)` 与 `runDeptFromEnv()`；直接执行该文件即按环境变量启动（打包时若用统一入口按 `ROLE=dept` 分派，请调用 `runDeptFromEnv()`）。


## 进度（2026-10-26）

- [x] M1 并行实现 A–F，各模块复审修复（hub 基础/流程、运行时、工具、网关沙箱、Web）
- [x] M2 进程内端到端（mock）：9 项全过（议事→颁旨→封驳→分派→执行→复奏→御览、定时、服务、口谕、部门重启、预算熔断、罢朝）
- [x] M3 Docker 端到端（mock）+ 混沌：8 项全过（容器重启、hub 停机 15s）
- [x] M4 真实模型：小圣旨 75s 走完（$0.014）；三部协作诏令（沙箱实跑 + 刑部核验）3 分钟（$0.023）；科举实考
- [x] M5 UI 实况联调（14 页、无控制台错误）、截图 docs/screenshots/live-*.png、README
