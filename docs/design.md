# 朕即天下 · 皇朝 Agent 系统 设计文档（v1）

> 基于 pi agent（`pi-agent-core` / `pi-ai`），以唐朝前期（武德—贞观）「三省六部 + 政事堂 + 御史台」为组织模型的多 Agent 持续运行系统。
> 用户 = 皇帝。一个官员 = 一个独立、持续运行的 Agent。一个部门 = 一个 Docker 容器。
> v1 合并了两轮评审（可靠性 / 需求与史实）的意见。

---

## 0. 关键决策速览

| 决策 | 选择 | 理由 |
|---|---|---|
| 真相源 | 皇城 hub（SQLite WAL，单写者）| 单机、写入量低；一致性简单 |
| 投递 | 目标「官员/部门 API」门面 → hub 落库（幂等）→ 门铃唤醒；收方按 cursor 拉取 | 满足「每人每部有 API 可被调用」，又不丢唤醒、不重复 |
| 状态变更 | 同步调用 hub + `expected_version` + 幂等键 | 公文状态机不可异步 |
| outbox | 只承载只追加数据（用量、事件、日志镜像）| 宕机可补投且无副作用 |
| LLM 访问 | 独立 **LLM 网关**（gateway 容器）持有密钥，限流、熔断、预算租约、记账 | 密钥不进部门容器；全局限流；精确记账 |
| 命令执行 | 独立 **将作监沙箱**（sandbox 容器）无密钥、不在朝廷网络 | 防提示注入横向移动 |
| 空闲 | 超时且无新事 → 代码级续睡，**不调 LLM** | 44 人空转成本为 0 |
| 防风暴 | hub 强制：唤醒规则、对话轮次上限、每人每小时轮次上限、议事协议 | 不靠提示词自律 |
| 卡死 | hub 确定性看门狗：租约过期改派、SLA 逐级上报 | 流程永不悬空 |
| 职位与人 | 职位 post（地址、收件箱、职责、工具上限）与官员 persona（模型、记忆、私产）分离 | 调岗/换模型不断址 |

---

## 1. 目标与非目标

目标
- 皇帝与政事堂议事 → 颁布圣旨 → 中书起草 → 门下审核（封驳 / 谏诤）→ 尚书省分派六部执行 → 复奏 → 皇帝御览。
- 皇帝亦可：直接颁旨（跳过政事堂）、对任一官员/部门下口谕、与任一官员私聊、批复待办。
- 每个官员持续运行，可自控：`sleep`、`wait_for`（必须超时）、`whats_happening`（发生什么事了）、`compact_memory`（自我整理）。
- 每人、每部门都有 HTTP API 与「服务」（可被他人调用的能力）；全部交流 API 封装为工具，工具足够多且按职授予。
- 每人、每部门可建定时任务；UI 管理。
- 每人、每部门有私有资产；皇帝可见全部。
- 所有 Agent 操作写 JSONL；御史台定期稽查（规则先筛 + LLM 复核）。
- 吏部：Agent 配置（提示词、思考强度、工具授权）、科举与考课。户部：token/成本预算与账本、人事（任免调迁、换模型）。礼部：文字。兵部：工具执行。刑部：测试纠错。工部：营造产物。
- Web：皇帝视角的诏令「任务调查」数据流转执行图；朝堂实时；部门/官员消息与工作内容；定时任务；资产；账本；科举；御史奏报；驿报。
- 可持续：任一容器宕机/重启不丢消息、不卡死流程、不重复副作用；预算熔断；风暴抑制；可回放。

非目标：多用户鉴权（单皇帝，本机）；多机水平扩展。

---

## 2. 总体架构

```
 皇帝(浏览器) ──HTTP/SSE──▶ ┌────────────── 皇城 hub ──────────────┐
                            │ Web UI · 皇城API · SQLite · SSE 驿报 │
                            │ 调度器(定时任务) · 看门狗 · 稽查规则 │
                            └──▲────────┬───────────────▲──────────┘
                     同步写/拉取 │  门铃/控制 │        用量/限额 │
 ┌──────────────────────────────┴────────▼─────────┐  ┌──┴──────────┐
 │ 部门容器×11（dept runtime）                       │  │ LLM 网关     │──▶ 各模型提供商
 │  官员Agent×N（pi Agent）+ 部门API + 官员API       │──▶ gateway     │
 │  本地：outbox、cursor、定时唤醒、会话 JSONL       │  └─────────────┘
 └───────────────┬─────────────────────────────────┘
                 │ (仅 兵部/工部/刑部) exec
          ┌──────▼──────┐
          │ 将作监沙箱    │ 无密钥 · 不在 court 网络 · 资源受限
          └─────────────┘
```

容器：`hub`、`gateway`、`sandbox`、11 个部门（`zhengshitang zhongshu menxia shangshu libu hubu libu2(礼部) bingbu xingbu gongbu yushitai`，ID 见名册）。网络：`court`（hub/gateway/部门）、`armory`（sandbox + 兵/工/刑部）。

### 2.1 消息投递（at-least-once + 幂等 = 恰好一次生效）

1. 官员 A 调工具 `send_message(to=B)` → A 的 runtime 向 **B 所在部门的官员 API** `POST /officials/B/messages`（携 A 的身份 token、幂等键 `A:turn:toolcall`）。
2. B 的部门门面同步调用 hub `POST /api/messages`：hub 校验 ACL、限流、分配 `message_id` 与收件人单调 `seq`，幂等键唯一索引防重。随后门面本地按铃唤醒 B。
3. 若 B 的部门不可达，A 的 runtime 直接写 hub（同一幂等键），hub 后续向 B 部门发门铃。
4. B 的 runtime 按 `acked_seq` cursor 从 hub 拉取：启动时、门铃时、每 30s 兜底。**处理该消息的那一轮持久化后才推进 cursor。**
5. 门铃丢失无害；重复门铃无害。

只读接口（状态、服务清单、资产列表）直接由部门 API 提供实时数据，失败回退 hub 心跳表。

### 2.2 状态变更

公文/任务/人事/配置/预算/定时任务等写操作：部门 runtime 同步调 hub，带 `expected_version` 与幂等键；hub 返回原结果（重试安全）。hub 不可达 → 工具返回明确错误；**hub 持续不可达 >30s → runtime 暂停所有官员的新轮次**，恢复后重同步。

### 2.3 outbox

仅：LLM 用量明细（网关已权威记账，部门侧为冗余）、事件镜像、日志摘要。磁盘持久、有上限与告警，恢复后补投，hub 按事件 ID 去重。

---

## 3. 组织与名册（`config/court.yaml`）

### 3.1 职位（post）

| 部门(容器) | 职位（一人一 Agent） | 职掌 |
|---|---|---|
| 政事堂 `zhengshitang` | 中书令（本官中书省长官，执政事笔·主持议事）、侍中（本官门下省长官）、尚书左仆射（本官尚书省长官）、同中书门下三品（参知政事）、堂后官（记录纪要，不发表意见）| 与皇帝议事、形成决策、拟旨意、早朝汇总 |
| 中书省 `zhongshu` | 中书侍郎（判省事，指派与复署）、中书舍人甲、中书舍人乙（起草）、右散骑常侍（谏官，起草阶段可谏）| 起草诏令（宣、奉、行简化）|
| 门下省 `menxia` | 门下侍郎（判省事，复署、指派主审）、给事中甲、给事中乙（封驳）、左散骑常侍（谏官，谏诤）| 审核诏令；封驳退中书；谏诤皇帝 |
| 尚书省 `shangshu` | 尚书右仆射（判都省事）、尚书左丞（督吏户礼）、尚书右丞（督兵刑工）、都事（督办、收发）| 分派六部、督办、汇总复奏 |
| 吏部 `libu` | 吏部尚书、吏部侍郎、考功郎中（考课、阅卷）、考功员外郎（知贡举、出题）| Agent 配置、科举、考课 |
| 户部 `hubu` | 户部尚书、户部侍郎、度支郎中（预算账本）、户部主事 | 预算与账本；人事（有意偏离史实：解释为「户部掌员额与俸禄」）|
| 礼部 `libu_rites` | 礼部尚书、礼部侍郎、礼部郎中（润色文书）、主客郎中（翻译）| 文字内容：润色、翻译、格式、术语表 |
| 兵部 `bingbu` | 兵部尚书、兵部侍郎、职方郎中（执行）、库部郎中（军械：工具清单）、驾部郎中（驿传：投递健康/死信）| 执行工具 |
| 刑部 `xingbu` | 刑部尚书、刑部侍郎、刑部郎中（测试纠错）、比部郎中（勾覆核账，与度支制衡）| 测试、核验、审计账目 |
| 工部 `gongbu` | 工部尚书、工部侍郎、工部郎中 | 营造：代码/文档产物 |
| 御史台 `yushitai` | 御史大夫、御史中丞、侍御史（台院·弹劾）、殿中侍御史（殿院·查议事与门下流程）、监察御史（察院·巡察）| 稽查、弹劾、奏报 |

史实注记（写入 UI「官制说明」）：尚书令因太宗曾任缺而不授，左右仆射为长官；政事堂贞观时在门下省（683 移中书省，723 改称中书门下）；705 年后仆射须加「同中书门下三品」方为宰相，本系统取前期制度；科举由考功员外郎知贡举（736 年移礼部）；户部管人事为按需求的有意偏离。

### 3.2 职位字段

`post_id`（地址，如 `menxia.jishizhong_a`）、`dept`、`title`、`rank`（品阶）、`benguan`（本官，宰相用）、`duties`、`tool_groups`（工具上限）、`services[]`、`routing_roles[]`（部门路由角色：`head|duty|drafter|reviewer|remonstrator|executor|...`）、`activity: always|on_demand`、`interruptible_by`、`default_schedules[]`、`approval_sensitive`（改其配置/人事须皇帝批）。

### 3.3 官员（persona）

`official_id`、`name`（生成的唐风姓名，非真实人物）、`model`（来自模型池）、`thinking`、`prompt_overrides`、`memory.md`、私有资产、会话。任命 = persona ↔ post 绑定（`appointments` 表带历史）。调岗：原部门 drain 当前轮 → 停 → hub 改绑 → 新部门拉起；会话/记忆跟人走，注入新职 duties。数据路径 `data/officials/<official_id>/`（共享卷，仅部门容器挂载）。

---

## 4. 官员运行时

### 4.1 主循环

```
loop:
  cond = 当前等待条件（持久化：next_wake_at + filter）
  wake = await 门铃/计时器/人工唤醒 满足 cond
  if wake.kind == timeout && 无新事: 代码级续睡（指数退避至上限），continue   # 不调 LLM
  if 罢朝 || hub 不可达 || 停俸: 暂停
  turn = 新 turn_id；写 turn 记录 {status: running, seq_range}
  prompt = 醒来简报（优先级：皇帝 > 自己名下公文变化 > 需答复的直信 > 定时任务 > 部门 > 抄送，最多 K 条，其余计数）
  await agent.prompt(prompt)   # LLM ↔ 工具，多步；中途皇帝来信用 steer() 注入
  turn.status = done；推进 cursor；持久化会话
  next = 本轮工具设定（sleep/wait_for/end_turn），默认 wait_for(需本人处理的事, 职位默认超时)
  上下文超阈值 → 自动压缩
```

### 4.2 唤醒规则（hub 侧打标 `wakes: bool`）

唤醒：皇帝消息/口谕/圣旨；`requires_reply` 的直信；本人名下公文/任务状态变化；本人定时任务到点；服务调用请求；本人所等之 `reply_to` 回复。
不唤醒（下次醒来时可见）：抄送、FYI、部门广播、`ack`。
`sleep` 可被 `interruptible_by`（默认：皇帝、圣旨、urgent）打断；sleep 上限 24h。

### 4.3 自我命令工具

`sleep(seconds, reason)`、`wait_for({from?, kinds?, trace_id?, reply_to?, timeout_seconds 必填 ≤ 86400})`、`end_turn(note)`、`whats_happening(scope?)`、`compact_memory(summary)`、`memory_note(op, text)`、`set_status(text)`、`my_status()`。
`ask_official` = 发问（`requires_reply`）+ 结束本轮 `wait_for(reply_to)`；不阻塞，信号量只包单次 LLM 调用。

### 4.4 上下文与压缩

- 系统提示分层（稳定，便于缓存）：朝廷通则 → 部门职掌 → 本人职责/权限/禁止事项 → 工具与服务清单。`memory.md`、结构化状态（名下公文/任务/等待/定时任务）、醒来简报放在 user 消息。
- 工具输出上限 8KB，超出存工作区/资产并返回路径 + 首尾摘录。
- 自动压缩：估算 token > 模型窗口 60% 或 > 配置上限 → LLM 生成摘要，保留最近 K 条；`compact_memory` 由官员自写摘要触发同样流程。压缩后运行时重注入结构化状态。完整历史永远在 JSONL 中可查。

### 4.5 崩溃恢复

会话按消息追加写 `session.jsonl`；turn 记录。重启时不重放 `running` 轮；对无结果的工具调用补一条「中断，结果未知，请先查询状态」的结果；cursor 未推进 → 消息重现。hub 侧副作用靠幂等键恰好一次；shell 至多一次。

### 4.6 安全阀

每轮工具调用 ≤ 40、时长 ≤ 10 分钟；每人每小时轮次 ≤ 20（超出强制睡并合并上报御史台）；两轮最小间隔 3s；新消息 2s 去抖；同一对官员同一线程 10 分钟 ≤ 6 来回；消息 `hop_count` ≤ 8；纯客套无副作用的回复不投递（运行时检测「收到/谢谢」类短回复）。

---

## 5. 公文流程（hub 状态机，全部 `version` 乐观锁）

### 5.1 议事 Deliberation（政事堂）

皇帝发言 → 主持（执政事笔，默认中书令）开议 → 宰相按序各发言一次（`council_speak` / `council_pass`，含立场 赞成/反对/保留）→ 主持决定是否二轮（≤ 2 轮）→ `council_conclude{结论, 异议, 建议旨意, 置信度}` → 皇帝待办：「照准颁旨 / 再议 / 搁置」。
唤醒：皇帝消息唤醒主持与全体；宰相发言只唤醒下一位发言人；超 token/时间上限 → 主持强制总结。堂后官自动生成纪要（会后）。

### 5.2 诏令 Edict

`issued → drafting → reviewing → approved → dispatched → executing → reported → completed`
旁路：`rejected`（封驳 → 回 drafting，`reject_count` ≤ 3，超出 `escalated` 皇帝圣裁）、`remonstrated`（谏诤，一版一次 → 皇帝：坚持/修改/撤回）、`blocked_budget`、`withdrawn`（仅皇帝，级联取消子任务）、`failed`。可选 `require_final_sign`（覆奏画可）→ `awaiting_sign`。
- 中书：侍郎指派舍人（hub 按路由规则自动指派，带租约）→ 舍人 `edict_submit_draft{目标, 约束, 验收标准, 期限, 预算上限, 建议承办部门, responses[]逐条回应封驳}` → 侍郎复署（可配置）。
- 门下：侍郎指派一名主审给事中 → `edict_review{decision: approve|reject, issues[]{severity: blocking|advisory, clause, reason(固定清单), required_change}}`；第 2 次起不得新增 blocking，只核对前次问题。左散骑常侍可 `edict_remonstrate{risk, alternative}`。
- 皇帝「墨敕」按钮：绕过门下，留痕并抄送御史台。
- 尚书：右仆射/左右丞 `edict_dispatch{tasks[{dept, title, instructions, acceptance, deadline, verify_by}]}` → 六部；全部任务终结后 `edict_report{summary, failures}` → 皇帝待办「御览」→ `completed`（或 N 小时后自动）。

### 5.3 任务 Task

`pending → assigned → in_progress ⇄ blocked → submitted → (verified | returned) → done | cancelled | failed`
父子任务；`verify_by: self|superior|xingbu`；`return_count` ≤ 3；转派 ≤ 2 次，第 3 次自动上报尚书都事；每官员未结任务上限。

### 5.4 看门狗（hub，确定性，每 30s）

每个非终态带 `state_entered_at` 与 SLA；指派带 `lease_until`。过期 → 改派同角色最闲健康者；SLA 超 → 逐级上报（承办 → 部门长官 → 尚书都事/政事堂 → 皇帝待办）。等皇帝的状态停泊，不轮询，只发提醒。

---

## 6. 服务、API 与工具

### 6.1 服务（可被他人调用的能力）

名册声明 `services[]{name, description, input_schema, sla_seconds}`，例：礼部 `polish`/`translate`/`format`，刑部 `verify`/`test`，兵部 `run`/`fetch`，户部 `budget_query`/`ledger`，吏部 `request_config_change`，工部 `build`，御史台 `complaint`。调用 = 异步请求（`request_id`），由部门路由给相应官员，结果回传请求者（唤醒）。

### 6.2 HTTP API

部门容器：
- `GET /health`（含各官员循环卡死检测）、`GET /dept`、`GET /dept/officials`、`GET /dept/services`、`POST /dept/inbox`、`POST /dept/services/:name`、`GET /dept/assets`、`GET /dept/schedules`
- `GET /officials/:post/status`、`POST /officials/:post/messages`、`POST /officials/:post/services/:name`、`POST /officials/:post/wake`、`GET /officials/:post/context`、`GET /officials/:post/log`、`GET /officials/:post/stream`(SSE 实时思考)、`POST /officials/:post/chat`（皇帝私聊）、`POST /control/*`（仅 hub：doorbell、reload、pause/resume、drain）

皇城 hub `/api/*`：registry、messages、inbox、threads、deliberations、edicts、tasks、services、notifications、schedules、assets、ledger、budget、models、exams、audit、spans/traces、events、stream(SSE，支持 Last-Event-ID，1s 合帧)、emperor/*。

网关 gateway：`POST /v1/stream`（pi-ai Context → 事件流）、`GET /v1/models`、`GET /v1/health`、预算租约。

### 6.3 工具清单（按 `tool_groups` 授予，每人约 20–35 个）

**通用 common**：
消息 `send_message` `reply_message` `forward_message` `escalate` `read_inbox` `get_thread` `search_messages` `ack_message` `ask_official` `message_department`；
名册 `list_departments` `list_officials` `get_official_profile` `get_official_status` `get_department_status`；
服务 `list_services` `call_service` `get_service_result`；
公文 `edict_get` `edict_list` `task_get` `task_list` `task_update` `task_comment` `task_submit` `task_block` `task_create_subtask` `trace_timeline`；
皇帝 `petition_emperor`（需批复，返回 notification_id）`report_progress`（FYI）；
资产 `asset_write` `asset_read` `asset_list` `asset_share` `asset_search`；
定时 `schedule`（action: create|list|update|pause|resume|delete|trigger_now|history；owner: self|department）；
自我 `sleep` `wait_for` `end_turn` `whats_happening` `compact_memory` `memory_note` `set_status` `my_status`。

**职能组**：
- `council`（政事堂）：`council_open` `council_speak` `council_pass` `council_conclude` `council_minutes` `propose_edict`
- `drafting`（中书）：`edict_submit_draft` `edict_countersign` `edict_request_clarification` `edict_diff`
- `review`（门下给事中）：`edict_review` `edict_diff`；`remonstrate`（谏官）：`edict_remonstrate`
- `dispatch`（尚书）：`edict_dispatch` `edict_report` `task_assign` `task_reassign` `task_cancel` `task_extend_deadline` `meeting_create`
- `ministry_head`（六部长官）：`task_assign` `task_reassign` `task_verify` `broadcast_department`
- `config`（吏部）：`config_get` `config_preview_prompt` `config_propose`（提示词/思考/工具，敏感项进皇帝待批）`config_history` `config_rollback` `request_model_change` `kaoke_evaluate`
- `exam`（考功）：`exam_list_models` `exam_add_question` `exam_list_questions` `exam_start` `exam_status` `exam_grade` `exam_results` `exam_publish`
- `finance`（户部）：`ledger_report` `ledger_by_trace` `budget_get` `budget_set` `budget_alert_set`；`personnel`：`personnel_appoint` `personnel_transfer` `personnel_dismiss` `post_vacancies` `personnel_history`（敏感项须皇帝批）
- `workshop`（兵/工/刑）：`ws_run` `ws_job_status` `ws_job_cancel` `ws_read` `ws_write` `ws_list` `http_fetch` `asset_publish_from_workspace` `asset_import_to_workspace` `tool_inventory`
- `justice`（刑部）：`task_verify` `bug_report` `bug_list` `bug_close` `test_run`
- `rites`（礼部）：`glossary_get` `glossary_update` `style_guide_get`
- `censor`（御史台）：`audit_findings`（规则命中）`audit_search_events` `audit_trace` `audit_logs` `audit_ledger` `impeach` `audit_report` `audit_followup` `audit_request_access`

所有授权在 hub 侧二次校验（工具没给 ≠ 安全，服务端 ACL 才是）。

---

## 7. 定时任务

- 归属：`official`（触发唤醒本人）或 `department`（投递部门收件箱，按路由给一人）。
- 规则：`cron`（5 段，时区 Asia/Shanghai，UTC 存储）/ `every_seconds` / `at`；`jitter_seconds`；`expires_at`；`payload`；`enabled`。
- 约束：最小间隔 5 分钟；每人 ≤ 10 条；Agent 建的 < 15 分钟间隔需长官批准（hub 记 `pending_approval`）；上一触发未处理则跳过并计 `missed_count`；宕机/休眠恢复后只补一次（带抖动）。
- 运行记录 `schedule_runs`：触发时间、message_id、trace_id、结果。
- 确定性巡检（看门狗/稽查规则/对账）由 hub 代码执行，只在发现问题时唤醒相应官员；默认 LLM 定时：政事堂每日早朝汇总、御史台每日奏报、考功每日检查待考模型。
- UI：全局/部门/官员三栏、cron 编辑器（下 5 次预览）、启停、立即触发、运行历史（链接 trace）、未来 24h 热图。

---

## 8. 资产

- 所有者：`official` / `department` / `court`；可见性默认 `private`（官员私有 = 本人 + 皇帝；部门私有 = 部门成员 + 皇帝）；`court` 公开；`share` 授权给指定官员/部门。
- 版本化（每次写入新版本，可 diff）；存 `data/hub/assets/`，元数据在 hub；访问审计记录。
- 日志中资产内容只记 `asset_ref + hash`；御史看私产须 `audit_request_access` 经皇帝批准。
- 工作区（沙箱）文件与资产互转：`asset_publish_from_workspace` / `asset_import_to_workspace`。

---

## 9. 预算、网关与账本

- 网关是唯一 LLM 出口：持有 API key；每提供商限流（并发、RPM）、429 遵循 retry-after、5xx 抖动退避 + 熔断探活；上下文过长返回特定错误由 runtime 压缩重试；鉴权错误不重试并通知吏部一次。
- 预算：全局/部门/官员/诏令(trace) 四级日额，token 与成本双维度；网关调用前预扣估算、调用后结算；超额拒绝（runtime 让官员「停俸」睡眠并生成户部待办 / 诏令 `blocked_budget` 皇帝待办）。
- 罢朝（全局急停）按钮：网关拒绝所有调用，runtime 暂停。
- 账本 `ledger`：每次调用一行（幂等键 `turn:call_idx`），含 trace、post、official、provider、model、tokens、cost、耗时、成功与否。
- 故障分级：一次提供商事故只生成一条合并事故通知；官员可配置候补模型（须科举达标）。

---

## 10. 科举与考课（吏部考功司）

- 模型池：皇帝在 UI 添加（provider/modelId/baseUrl/api/价格）→ `candidate` → 自动排考。
- 题库：内置基础题库（客观可自动判分）+ 考功员外郎出题（`exam_add_question`，存吏部私有资产，考后公开）。维度：推理、指令遵循、中文写作、翻译、工具调用、结构化输出(JSON)、代码、摘要。
- 考场：hub 考场执行器经网关直接用候选模型作答（工具调用题配模拟工具），记耗时/token/成本。
- 阅卷：客观题自动判分；主观题由考功郎中/阅卷模型盲评（候选模型不评自己；出题官模型不考本卷）。
- 金榜：维度分 × 部门适配权重 → 部门适配矩阵；户部任命/换模型须适配度达标（皇帝可强制）。
- 考课：考功郎中按任务结果、御史记录定期给在任官员评等（上中下），供户部升降参考。所有在任官员的模型定期岁考。

---

## 11. 追踪、日志与观测

- 追踪：每轮、LLM 调用、工具调用、消息、公文变更、任务、资产版本、定时运行都带 `trace_id / span_id / parent_span_id`，**由运行时自动传递**：被消息唤醒的轮继承该消息 trace；工具参数含 `edict_id/task_id/reply_to` 时据此推导；否则新建并标记。hub `spans` 表是执行图唯一数据源。
- JSONL：`data/officials/<official_id>/logs/YYYY-MM-DD.jsonl`，每行 `{ts, official_id, post_id, dept, type, trace_id, span_id, turn_id, ...}`；type：`wake turn_start llm_start llm_end tool_call tool_result message_out message_in sleep wait compact error config_reload budget_block turn_end`；按日轮转、保留 30 天、脱敏。
- hub 事件只镜像生命周期/用量/错误/状态变更；原始细节通过官员 API 读 JSONL。
- 心跳表：`status, current_turn_id, last_progress_at, next_wake_at, wait_filter, reason`。
- hub `/api/health`：outbox 积压、投递滞后、最老悬置公文、token 燃烧率、提供商错误率。
- 稽查规则（确定性）：循环对话、空转、超期、工具报错率、宣称完成无产物、越权尝试、注入可疑 → `audit_findings`，御史台醒来复核。

---

## 12. 权限与制衡

- 每官员独立 token（hub 签发，部门容器持有本部门官员 token）；hub 按调用者做 ACL。
- 须皇帝批准：改御史台/门下/政事堂/吏部任一官员配置；任何工具授权或模型变更；调动宰相/御史/给事中；新增/罢免官员；高频定时任务以外的预算上调超过阈值。
- 官员不得改自己的配置；配置版本化，下一轮生效，异常（错误率/轮次飙升）自动回滚。
- 外部内容（`http_fetch`、命令输出、他人消息）在上下文中标注为「不可信资料」。
- 皇帝通知：`action_required`（批旨、人事、封驳升级、谏诤、预算熔断、科举放榜、弹劾、配置审批）与 `fyi`；`petition_emperor` 每人每小时 ≤ 3，超出合并。批复回写发起人（唤醒）。
- 弹劾流程：`impeach` → 皇帝待办（证据链到 span）→ 驳回 / 交吏部改配置 / 交户部降职换模型停俸 / 交刑部复核。

---

## 13. Web UI（皇帝视角）

1. 御书房：待办（需决断/仅通知/封驳升级/谏诤）、进行中诏令卡（阶段进度、成本、阻塞）、早朝纪要、预算仪表、告警、罢朝开关。
2. 政事堂议事厅：聊天 + 发言轮次指示 + 宰相立场卡 + 结论面板（照准颁旨/再议/搁置）+ 议事 token 计数。
3. 颁旨/口谕/私聊：颁旨表单（目标、验收、期限、预算、是否跳过政事堂）；与任一官员/部门对话。
4. **诏令调查（核心）**：DAG 数据流转执行图（圣旨→草稿 vN→封驳循环→分派→部门任务→子任务→复奏，状态着色，耗时/成本，关键路径，阻塞闪烁）；泳道时序图（按部门/官员，箭头=消息与服务调用，时间轴回放）；节点详情抽屉（span 树：轮次→LLM→工具→消息；产物；草稿 diff；封驳意见与回应）。
5. 朝堂：部门网格 × 官员卡（状态、等待对象与超时、当前 trace、token 速率）、部门间消息流量、容器健康。
6. 部门页：收件箱、任务看板、服务与调用统计、资产、定时任务、用量、递公文。
7. 官员页：实时流（思考与工具调用）、收发件与线程、当前上下文查看器、压缩历史、memory.md、私产、名下任务、定时任务、配置与 diff、用量、考课、弹劾记录；操作：唤醒/暂停/强制压缩/私聊。
8. 定时任务、9. 资产库、10. 户部账本、11. 吏部名册与配置审批、12. 科举（模型池、题库、考试、金榜雷达与适配矩阵）、13. 御史台奏报、14. 驿报（事件流 + 死信重投）。

---

## 14. 部署与运维

- 单镜像多角色：`ROLE=hub|gateway|sandbox|dept`，`DEPT=<id>`；`docker-compose.yml` 14 个服务；`restart: unless-stopped`；健康检查；`stop_grace_period: 40s`（SIGTERM：不开新轮 → 当前轮 30s 内结束或中止 → 刷 outbox → 存会话）。
- 卷：`data/hub`（仅 hub）、`data/officials`（部门共享）、`data/depts/<id>`（各自 outbox/cursor）、`data/sandbox`（工作区）。
- SQLite：WAL、busy_timeout、synchronous=NORMAL、单写连接队列、版本化迁移、每日 `VACUUM INTO` 备份；事件保留 14 天。
- 配置：`config/court.yaml`（名册/路由/服务/工具上限/审批策略）、`config/models.yaml`（模型池）、`.env`（密钥，仅网关读取）。
- `LLM_MODE=mock`：网关切换为脚本化假模型（按职位/工具剧本作答），零成本跑通全流程；混沌测试：杀部门、hub 停 10 分钟、重复门铃、429 风暴、休眠后定时补跑；不变量：无超 SLA 未上报公文、恢复后 outbox 清空、账本一致、消息不重复生效。

---

## 15. 实施后修订（v1.1，依实测与复审）

| 项 | 修订 | 来源 |
|---|---|---|
| 皇城端口 | 拆为两个监听：内部 API `8000`（必须带 token，永不视为皇帝）与皇帝/Web `8001`（无 token 即皇帝，仅发布到 127.0.0.1）| 安全复审 |
| LLM 接入 | 部门经 pi-agent-core `streamProxy` → 网关 `/api/stream`；元数据走 `options.metadata`；网关错误前缀 `BUDGET_EXCEEDED/HALTED/CIRCUIT_OPEN/AUTH_ERROR/CONTEXT_TOO_LONG/RATE_LIMITED/UPSTREAM_ERROR` 驱动官员状态 | 运行时实现 |
| 结束型工具 | 同批中结束工具之后的普通工具照常执行但标记 terminate（不再多耗一次 LLM）；之后的结束型工具不执行（首个等待条件生效）| 真实模型冒烟 |
| 公文自动通知 | 公文类工具返回「已自动通知下一环节，无需另行发信」；朝廷通则第 10、11 条 | 真实模型冒烟（冗余发信）|
| 任务批注 | 批注以批注人名义投递并唤醒相关人（等「某人来信」的 wait_for 可被批注唤醒）| 浸泡测试（刑部空等 30 分钟）|
| 同诏协作 | 同诏某任务办结/失败 → 以 `edict_notice` 知会其余未结任务承办人（可打断 wait_for）| 浸泡测试：三部协作诏令由 >30 分钟降至 3 分钟 |
| 交付物共享 | 任务提交附资产时自动分享给核验人、创建者、分派人、父任务承办人 | 冒烟（403）|
| 起草纪律 | 中书验收标准不得写入未经实算的数值；门下以此封驳 | 浸泡测试（模型臆测「967」）|
| 追踪 | 轮 span 以触发消息/对象 span 为父；hub 公文 span 记录 `attrs.by_span`；`status.changed` 经 SSE 推送但不落库 | Web 联调 |
| 长跑卫生 | 日志每日按保留期清理；会话文件 >4MB 于压缩点轮转归档；outbox 溢出时文件有界；`sleepMs` 不泄漏监听；跨部门调岗以 `runtime.lock` 防双写 | 运行时复审 |
| 科举 | 基础题有天花板效应（两模型同为 98.8）→ 增加可确定判分的难题档与速度/成本维度 | 浸泡测试 |
| 轮次上限 | 分级：每小时「空转」轮次（只读/结束类工具）≤ 20；全部轮次硬上限 80；超限报 `suspended`，派活时避开，已派之事由看门狗改派 | Docker 回归：右仆射作为全部诏令的分派与核验人被 20 轮上限饿死 |
| 档案库存储 | `HUB_DB_PATH` 可独立放置；macOS 默认命名卷 `hub-db`（宿主绑定卷上 SQLite WAL 的 mmap/锁不可靠，曾致 OrbStack 卷挂起），首次启动自动迁移旧库 | Docker 运行事故 |
| 模型提供商 | 网关注册 pi 全部内置提供商（`builtinProviders()`，约 41 家）；凭据走 pi 的 `CredentialStore`，落盘 `DATA_DIR/gateway/credentials.json`（0600），环境变量为后备（`.env.providers` 经 compose `env_file` 注入）；设置页经 hub → 网关 `/admin/*`（仅网关 token）驱动 provider 自带登录流程（api-key 提示、OAuth 授权链接/设备码/回填授权码），任何接口不回传密钥本体；自定义 OpenAI/Anthropic/Google 兼容提供商存 `providers.json`；单接口提供商允许目录外模型 ID（按该提供商推断）；入池前 hub 向网关核验 provider/model | 用户需求：在设置中添加多种 pi 支持的 provider |
| MCP 工具 | 新增 `mcp` 中转站容器（端口 8300）：hub 表 `mcp_servers` 只存配置（密钥只写不读、待批配置暂存 meta 且不进审批载荷）；授权对象 所有人/部门/官员 可多选；streamable HTTP 与 stdio（每服务器一个独立 `docker run -i` 容器，bridge/none 网络）；官员按授权动态装配 `mcp__<server>__<tool>` 工具（`/control/mcp` 推送 + 5 分钟兜底刷新）；`mcp_admin` 工具组提供完整配置 API，放大权限须皇帝批准。详见 `docs/mcp.md` | 用户需求：设置中接入 MCP |
