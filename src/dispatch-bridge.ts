/**
 * 派发桥：tools.ts（run_momoka_cli 的 agent chat/dispatch/verdict 子命令）与
 * 编排层（agent-orchestration 的 handleDispatchBridge）之间的进程内接缝。
 *
 * 为什么存在：值日生派发过去靠 spawn momoka CLI → CLI 再 HTTP 回环到同一台服务器
 * （多一次 node 冷启动 + 60s 超时面），且台账创建依赖解析 CLI 参数字符串。
 * 桥把这两件事收敛为一个结构化调用；http.ts 装配时注册 handler，工具层命中
 * 相关子命令时直调。未接线（单测/独立脚本）时工具层回落旧的 CLI 路径。
 */

export interface DispatchBridgeInput {
  kind: "chat" | "dispatch" | "verdict" | "ledger";
  /** chat/dispatch：执行者 Agent id（agt_…） */
  executorId?: string;
  /** chat/dispatch：任务书（调用者已拼好；这里不再改写） */
  task?: string;
  /** dispatch：复用确认凭证（ask_question 的 qst_ id） */
  confirm?: string;
  /** verdict：台账条目 id（dsp_…） */
  entryId?: string;
  /** verdict：判读结论 */
  choice?: "deliver" | "continue";
  /** verdict：可选备注（判读依据/交付说明） */
  note?: string;
  /** ledger：操作类型（list 概览 / show 单条 / cancel 放弃条目） */
  op?: "list" | "show" | "cancel";
  /** ledger list：状态过滤，缺省 active（未结单） */
  state?: "active" | "all";
  /** 调用者会话（用于 dispatcher 判定与判读权校验） */
  callerSessionId: string;
}

export interface DispatchBridgeResult {
  ok: boolean;
  /** 给调用者（值日生模型）看的回执文本 */
  output: string;
  /** dispatch/chat 成功时返回台账条目 id */
  dispatchId?: string;
}

export type DispatchBridgeHandler = (input: DispatchBridgeInput) => Promise<DispatchBridgeResult>;

let handler: DispatchBridgeHandler | null = null;

export function setDispatchHandler(next: DispatchBridgeHandler | null): void {
  handler = next;
}

export function getDispatchHandler(): DispatchBridgeHandler | null {
  return handler;
}
