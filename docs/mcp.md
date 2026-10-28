# MCP 工具接入（设计 v1）

> 需求：设置里可配置 MCP 服务器；可授权给所有人 / 某部门 / 某人（可多选）；支持 streamable HTTP 与 stdio；存储只存配置；stdio 在独立 docker 中运行；提供完备 API 供相关部门配置、调整。
> 契约：`packages/shared/src/mcp.ts`（类型、broker 客户端、纯函数）、`api.ts` 中 HubClient 的 `mcp*` 方法、`tool-groups.ts` 的 `mcp_admin` 组、`consts.ts` 的 `MCP_PORT=8300`、`types.ts` 中 `Approval.type` 的 `"mcp_config"`。任何模块不得擅改契约；确需修改须在报告中说明。

## 1. 组件与数据流

```
皇帝 Web ─/api/mcp/*─▶ hub ──(表 mcp_servers：仅配置；密钥只写不读)
官员(mcp_admin 组) ─/api/mcp/*─▶ hub ──(敏感变更进皇帝待批 approval type=mcp_config)
hub ──POST /admin/reload（broker token）──▶ mcp broker ──GET /api/internal/mcp/state──▶ hub
hub ──POST /control/mcp（control token）──▶ 各部门：标记 MCP 工具待刷新
官员 runtime ──GET /v1/tools、POST /v1/call（部门 token + X-Acting-Post）──▶ broker ──▶ MCP 服务器
broker ──docker run -i --rm（每个 stdio 服务器一个容器）──▶ 宿主 docker（挂 /var/run/docker.sock）
```

- **存储只存配置**：hub SQLite 表 `mcp_servers(id TEXT PRIMARY KEY, version INTEGER NOT NULL, updated_at INTEGER NOT NULL, data_json TEXT NOT NULL)`（`McpServerConfig`）与 `meta.mcp_version`（总版本，任何变化 +1）。连接状态、工具清单缓存只在 broker 内存，不落库。
- **密钥**：`env`、`headers` 的值只在 hub 库与 broker 内存中；所有对外接口返回 `McpServerView`（只给键名 `env_keys/header_keys`）。修改时值为 `null` = 沿用旧值；缺省字段 = 不改；给出字段时未出现的键 = 删除。
- **broker token**（`MCP_TOKEN`）：hub ↔ broker 双向共用的密钥。hub `ensureTokens` 管理（env 优先，否则 meta `token_mcp`，否则生成 `mc_`+48hex），**只写入 `DATA_DIR/hub/tokens.json`，不写 `shared/tokens.json`**（部门可读 shared）。docker 部署由 `.env`（init.mjs 生成）注入 hub 与 mcp 两个服务。
- **部门 → broker**：部门 token（`Bearer dk_...`）+ `X-Acting-Post`。broker 从 internal state 的 `tokens` 认部门，校验 post 属于该部门（`posts[post].dept === dept`），再按 `targets` 对 `{dept, official_id}` 判定（`mcpMatchTargets`）。

## 2. hub

### 2.1 鉴权
- `Principal.kind` 增加 `"mcp"`：Bearer 等于 `ctx.mcpToken` 时。新增 `requireMcpBroker(c)`（mcp 或 system）。mcp principal 对其他接口一律 403（同 gateway 处理方式：`requireTool`/`requireActingPost` 等对 mcp 返回 403）。
- HubCtx 新字段：`mcpUrl: string`（可变；默认 env `MCP_URL` 或 `http://mcp:8300`）、`mcpToken: string`、`mcp: McpService`。

### 2.2 接口（同时挂在两个监听上；皇帝 = 8001 无 token）

| 方法 路径 | 谁可调 | 说明 |
|---|---|---|
| GET `/api/mcp/servers` | 皇帝；工具 `mcp_list_servers` | 列表（View），按 id 排序 |
| GET `/api/mcp/servers/:id` | 皇帝；`mcp_get_server` | 单个 |
| POST `/api/mcp/servers` | 皇帝；`mcp_create_server` | 新建。皇帝 → applied；官员 → pending_approval |
| PATCH `/api/mcp/servers/:id` | 皇帝；`mcp_update_server` | 修改；`expected_version` 不符 409。官员：见 2.3 |
| DELETE `/api/mcp/servers/:id` | 皇帝；`mcp_delete_server` | 删除（官员亦直接生效：收缩权限不需批） |
| POST `/api/mcp/servers/:id/test` | 皇帝；`mcp_test_server` | broker `/admin/test`（已存配置） |
| POST `/api/mcp/servers/:id/restart` | 皇帝；`mcp_test_server` | broker 重连 |
| POST `/api/mcp/test` | 仅皇帝 | 测草稿 `{base_id?, server}`：校验 → 合并 base 密钥 → broker test。不保存 |
| GET `/api/mcp/status` | 皇帝；`mcp_list_servers` | broker `/admin/status`；broker 不可达 → 503 unavailable |
| GET `/api/mcp/access?post=` | 皇帝；`mcp_get_access`；或官员查自己（post = 本人） | `McpAccess` |
| GET `/api/internal/mcp/state` | 仅 broker（mcp principal）/system | `McpInternalState` |

写接口：`idem_key` 走 `ctx.idem.wrap(\`mcp:${actor}:${idem_key}\`)`；事件 `mcp.created|mcp.updated|mcp.deleted|mcp.requested`（`subject_type:"mcp_server"`，summary 中文，**不得含密钥值**）。

### 2.3 校验与审批
- 校验（`bad` 400，中文可操作）：id 合 `MCP_ID_RE` 且新建时不重复（409 invalid_state）；name 1–60 字；description ≤ 500；transport 合法；http：url 为 http/https、headers 键合 `MCP_HEADER_KEY_RE`、≤ maxHeaders；stdio：image 非空（缺省填 `MCP_DEFAULT_IMAGE`）、合 `^[a-zA-Z0-9][a-zA-Z0-9_./:@-]{0,254}$`，command 非空，args ≤ maxArgs 且每项 ≤ 4096 字，env 键合 `MCP_ENV_KEY_RE` 且 ≤ maxEnv，network ∈ bridge|none（缺省 bridge），memory_mb/cpus 范围见 `MCP_LIMITS`；timeout_seconds 1..600；targets ≤ maxTargets，dept 必须存在于名册、official 必须存在，去重；tool_allow ≤ maxToolAllow。服务器总数 ≤ maxServers。切换 transport 时清掉另一种的字段。
- 皇帝：全部直接生效。
- 官员（`mcp_admin`）：
  - 新建 → 皇帝待批。
  - 修改：**只收缩**（仅停用、移除授权对象、缩小 tool_allow、改 name/description/timeout）→ 直接生效；任何「放大」（启用、新增授权对象、tool_allow 放宽或清空、改连接字段 url/headers/image/command/args/env/network/memory/cpus、改 transport）→ 皇帝待批。
  - 删除 → 直接生效。
  - 待批 payload 存完整的目标配置（含密钥）与 `base_version`；批准时若当前版本 ≠ base_version → apply 失败（提示重新申请）。
  - `ctx.approvals.request("mcp_config", payload, actor, title, body)`；body 列出差异（密钥只说「改了哪些键」）。
- 生效后：`ctx.db.tx` 内写表 + bump `meta.mcp_version` + 事件；事务后 `setImmediate`：`mcpAdmin().reload()`（失败忽略、记 `mcp.broker_unreachable` 事件，节流 1 分钟）→ 然后 `controlAll(ctx, "/control/mcp", {})`。

### 2.4 internal state
`{version: meta.mcp_version, servers: 全部配置（含密钥）, tokens: 部门 token→部门, posts: 每个 post → {dept, official_id(现任)}}`。人事变动（任免调迁）后 broker 不会被通知 → broker 每 30s 轮询一次即可（state 很小）。

## 3. broker（`packages/mcp`，ROLE=mcp，端口 8300）

- `startMcp({ port?, hostname?, hubUrl, token, runner: "docker"|"local", blockedHosts?: string[], dockerBin?: string, pollMs?: number, idleMs?: number }) => Promise<{ url, port, close() }>`（`src/server.ts`）；`src/main.ts` 从环境变量启动（`PORT`、`HUB_URL`、`MCP_TOKEN`、`MCP_STDIO_RUNNER`、`MCP_BLOCKED_HOSTS` 逗号分隔、`DOCKER_BIN`）。`MCP_TOKEN` 缺省时尝试读 `DATA_DIR/hub/tokens.json` 的 `mcp`（开发态同机）。
- 路由：`GET /health`（无鉴权）；`/v1/*`（部门 token + X-Acting-Post）；`/admin/*`（broker token，timingSafeEqual）。错误 `{error, code}`（ErrorCode）。
- `GET /v1/tools` → `McpCatalog`：只含 enabled 且授权命中的服务器；每个服务器 lazy 连接并缓存工具清单（按 tool_allow 过滤，至多 maxToolsPerServer）；连接失败的服务器给出 `error` 与空工具，**不得让整体失败**；并发连接，单服务器列工具总时限 20s（stdio 首次拉镜像可能更久：超时则返回 error「正在启动」，后台继续连接）。`version` = `${state.version}:${授权服务器 id@version 列表}:${各服务器工具清单哈希}`。
- `POST /v1/call` → 校验授权、enabled、tool_allow；`client.callTool({name, arguments}, undefined, {timeout})`；结果转 `McpCallRes`（text/image/resource/other；image 超 1MB 改 other）。工具不存在 404；超时 → 504 code `unavailable`；MCP 层 isError → 200 `is_error: true`。连接断了自动重连一次再试。
- `/admin/reload`、`/admin/status`、`/admin/test`（临时连接，测完关闭；stdio 测试容器名带 `-test-`）、`/admin/servers/:id/restart`。
- 连接管理：每服务器一个 `Client`（`@modelcontextprotocol/sdk`），键 `id@version`；配置版本变化/停用/删除 → 关闭旧连接（stdio 即停容器）。stdio 闲置 `idleMs`（默认 10 分钟）无调用 → 关闭，下次按需重启。连接错误指数退避（10s→5min）避免反复拉起。监听 `onclose/onerror`。
- streamable HTTP：`StreamableHTTPClientTransport(new URL(url), { requestInit: { headers } })`；`blockedHosts` 命中（主机名精确匹配，大小写不敏感）→ 拒绝（防经 broker 打朝廷内部服务）。
- stdio（runner=docker）：`StdioClientTransport({ command: dockerBin, args, env: { ...getDefaultEnvironment(), ...secretEnv }, stderr: "pipe" })`，args：
  `run -i --rm --name court-mcp-<id>-<rand6> --label court.mcp=<id> --label court.mcp.version=<v> --network <network> --memory <m>m --cpus <c> --pids-limit 256 --cap-drop ALL --security-opt no-new-privileges --read-only --tmpfs /tmp:rw,exec,nosuid,size=512m --tmpfs /root:rw,nosuid,size=256m --tmpfs /home:rw,nosuid,size=64m -e HOME=/tmp -e npm_config_cache=/tmp/.npm -e UV_CACHE_DIR=/tmp/.uv [-e KEY ...] <image> <command> <args...>`
  —— 密钥通过 docker CLI 进程环境传入（`-e KEY` 不带值），不出现在命令行。stderr 收集末尾 4KB 用于错误信息。关闭时额外 `docker rm -f <name>` 兜底。启动时 `docker ps -aq --filter label=court.mcp` 清理遗留容器。
  - 注：`--read-only` 下 npx 需写缓存，故 HOME/缓存指向 tmpfs。
- runner=local（**仅测试/开发**）：直接 spawn `command args`，env 同上；启动时打印警告。
- 日志：stdout 一行 JSON（启动、连接、断开、错误），不得打印密钥。

## 4. 部门 runtime（`packages/dept`）

- `StartDeptOptions.mcpUrl?`（默认 env `MCP_URL` 或 `http://mcp:8300`），`DeptRuntime` 构造 `new McpClient({ baseUrl, token: tokens.dept, timeoutMs: 15 分钟 })`；每官员 `withPost(post_id)`；`ToolContext.mcp?: McpClient`。
- 部门控制面新增 `POST /control/mcp` → 所有官员 `markMcpDirty()`。
- 动态工具：官员在轮次边界（与 configDirty 同处）若 mcpDirty 或距上次刷新 > 5 分钟 → `catalog()`；`version` 变化才重建：工具 = 原工具 + 每个 MCP 工具（名 `mcpToolName(server, tool)`，label `MCP·<server>`，description = `【MCP·<服务器名>】<工具描述>`（≤ 1024 字），parameters = MCP inputSchema 原样（缺省 `{type:"object",properties:{}}`；须是 object 型，否则包一层），execute → `mcp.call` → 文本拼接 + `untrusted()` 标注 + 8KB 截断；image 内容转成 ImageContent 直接给模型（≤ 1MB）。`is_error` → `isError: true`）。直接设 `agent.state.tools`（pi 会自动以 system 消息宣告增删）；config 重建工具时也要并入当前 MCP 工具。broker 不可达 → 保持现有 MCP 工具，下轮再试；失败不影响轮次。
- 工具组 `mcp_admin`（`tools/mcp.ts`）：`mcp_list_servers`、`mcp_get_server`、`mcp_create_server`、`mcp_update_server`、`mcp_delete_server`、`mcp_test_server`、`mcp_get_access` —— 调 hub 对应接口；写类工具带 `idem_key`/`trace_id`/`reason`；返回 pending_approval 时提示「已呈皇帝待批，批复后会通知你」。

## 5. Web（设置页）

- 设置页顶部 Tabs：「模型提供商」｜「MCP 工具」（`?tab=mcp`）。
- MCP 页：统计（服务器数 / 启用 / 就绪 / 工具总数）；服务器卡片（名称、id、transport 标签、状态（来自 /api/mcp/status）、授权对象 chips、工具数、启停开关、测试、重启、编辑、删除）。
- 编辑抽屉：id（新建可填）、名称、说明、transport 切换；HTTP：URL + 请求头行（值为密码框；已存键显示「已设置·留空沿用」）；stdio：镜像（预设下拉 + 自由输入）、命令、参数（每行一个）、环境变量行（同请求头）、网络（bridge/none）、内存、CPU；高级：超时、工具白名单（测试后可勾选）；授权对象多选：「所有人」开关 + 部门复选 + 官员选择器（PostPicker 选人加 chip，存 official_id）。底部「测试连接」（草稿测试，显示工具清单）与保存。
- 说明文案：stdio 在独立容器运行；HTTP 地址须从 broker 容器可达；密钥只写不读。

## 6. 部署

- `scripts/build.mjs` 加 `mcp`；`docker/entrypoint.sh` 加 `mcp`；`docker/mcp.Dockerfile`（node:24-slim + `COPY --from=docker:28-cli /usr/local/bin/docker`，root 运行以访问 socket，EXPOSE 8300）。
- `gen-compose.mjs`：服务 `mcp`（hostname mcp，court 网络，`/var/run/docker.sock` 挂载，env `MCP_TOKEN`、`HUB_URL`、`MCP_STDIO_RUNNER=docker`、`MCP_BLOCKED_HOSTS=hub,gateway,sandbox,mcp,<各部门主机名>`，healthcheck）；hub 与各部门加 `MCP_URL=http://mcp:8300`，hub 加 `MCP_TOKEN`。
- `init.mjs` 生成 `MCP_TOKEN`（前缀 `mc`）；`.env.example` 补充。Dockerfile 的 `COPY packages/*/package.json` 列表加 mcp。
- `tests/harness.ts` 的 `startCourt`：建 hub 后起 broker（`runner: process.env.MCP_STDIO_RUNNER ?? "local"`，blockedHosts 空），设 `hub.ctx.mcpUrl`，部门传 `mcpUrl`。

## 7. 安全说明
- broker 挂 docker socket 等同宿主 root：broker 只运行皇帝批准过的配置；stdio 容器不入朝廷网络、无能力、只读根、资源受限。
- 官员不能读取密钥；不能测试未保存草稿（草稿可能是任意代码）；放大权限须皇帝批准。
- MCP 输出视为不可信资料（`untrusted()`），与 http_fetch 同等对待。

## 8. 实施修订（v1.1）

| 项 | 修订 | 理由 |
|---|---|---|
| 待批载荷 | 审批 payload 只存去密钥的视图 `{op, id, server(view), base_version, reason, actor}`；完整配置暂存 meta `mcp_pending:<approval_id>`，批准/驳回/应用失败后删除 | `GET /api/approvals` 部门 token 可读，原方案会泄露密钥 |
| 版本号 | `server.version` 取全局 `mcp_version` 的新值（单调递增）| 删除后同 id 重建不会复用 broker 的 `id@version` 连接 |
| broker token 隔离 | mcp principal 在中间件层即被拒于 `/api/internal/mcp/` 之外的全部接口 | 许多旧接口只排除 gateway，其余视同皇帝 |
| 保留环境变量 | `PATH`、`HOME`、`npm_config_cache`、`UV_CACHE_DIR` 与 `DOCKER_*` 不得作为 stdio 环境变量（hub 校验 + broker 兜底）| 密钥经 docker CLI 自身环境传入，这些名字会改变 CLI 行为 |
| 长调用 | hub 调 broker 测试/重启用长超时（首次拉镜像可达数分钟）；reload/status 短超时 | 实测 |
| 屏蔽主机 | compose 中 `MCP_BLOCKED_HOSTS` 另含 `localhost`、`127.0.0.1` 与各部门服务名；仅按主机名匹配 | 防经 broker 访问朝廷内部服务 |
| 调用错误 | 未授权/不存在 404；MCP 协议级错误（如参数错误）返回 200 `is_error:true` 让模型自纠；仅在连接丢失时自动重连重试一次 | 可纠错性 |
| 部门参数 | `startDept` 未给 `mcpUrl` 则不装 MCP（`runDeptFromEnv` 才回退 `MCP_URL`/`http://mcp:8300`）| 旧测试不触网 |
| 官员工具参数 | `mcp_create_server`/`mcp_update_server` 的 headers/env 用 `[{key, value?}]` 列表（缺 value = 沿用已存值），工具内转为 `Record<string,string\|null>`；工具调用日志里密钥值替换为 `***` | `Type.Record` 产生 `patternProperties`，部分提供商拒收 |
| 刷新时机 | 官员启动时先取一次目录（≤5s）；轮次边界等待 ≤5s，超时的结果下一轮生效；服务器出错时保留其旧工具，1 分钟后重取 | 不让 broker 卡住轮次 |
| control token | MCP 配置接口与 internal state 均拒绝 system 身份 | control token 存于部门可读的 shared/tokens.json |
