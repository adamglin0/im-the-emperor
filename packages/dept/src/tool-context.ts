// 官员运行时 ↔ 工具 的契约。工具实现（tools/*.ts）只依赖本接口；runtime（official.ts）实现它。
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type {
  DeptClient,
  DeptDef,
  HubClient,
  Official,
  OfficialStatus,
  PostDef,
  Registry,
  SandboxClient,
  SendMessageReq,
  SendMessageRes,
  WaitFilter,
  CallServiceReq,
  ServiceRequest,
} from "@court/shared";

export interface TurnInfo {
  turn_id: string;
  /** 当前轮聚焦的 trace（被消息唤醒则继承；工具参数含 edict/task/reply_to 时由工具更新） */
  trace_id: string;
  span_id: string;
  wake_reason: string;
}

export interface ToolContext {
  readonly post: PostDef;
  readonly official: Official;
  readonly dept: DeptDef;
  /** 已带 acting post 的 hub 客户端 */
  readonly hub: HubClient;
  /** 兵/工/刑部才有 */
  readonly sandbox?: SandboxClient;
  /** 本部门工作区名（沙箱内） */
  readonly workspace: string;
  registry(): Registry;
  /** 访问其他部门的部门/官员 API */
  deptClient(dept: string): DeptClient;
  turn(): TurnInfo;
  /** 显式切换当前 trace（工具在处理某诏令/任务/回复时调用） */
  focusTrace(traceId: string): void;
  /** 幂等键：<post>:<turn>:<toolCallId> */
  idemKey(toolCallId: string): string;

  /**
   * 投递消息给某地址：post:x → 目标部门官员 API；dept:y → 目标部门 API；其他 → hub。
   * 目标部门不可达时回退直写 hub（同一幂等键）。
   */
  deliver(req: SendMessageReq): Promise<SendMessageRes>;
  /** 调用服务：post/dept 目标经其 API，失败回退 hub */
  invokeService(req: CallServiceReq): Promise<ServiceRequest>;

  // ── 自我控制（本轮结束型工具使用；调用后工具应返回 terminate: true） ──
  sleep(seconds: number, reason: string): void;
  waitFor(filter: WaitFilter, timeoutSeconds: number): void;
  endTurn(note: string): void;
  /** 自我压缩：summary 为官员自写摘要（可空则由 LLM 生成），在本轮结束后执行 */
  requestCompaction(summary?: string): void;

  // ── 记忆与状态 ──
  memoryRead(): string;
  memoryWrite(op: "append" | "replace" | "clear", text: string): string;
  setStatusText(text: string): void;
  status(): OfficialStatus;
  contextTokens(): number;

  /** 写本人 JSONL 日志 */
  log(type: string, data: Record<string, unknown>): void;
}

/** 工具工厂：每个工具组一个模块，导出 (ctx) => AgentTool[] */
export type ToolFactory = (ctx: ToolContext) => AgentTool<any>[];
