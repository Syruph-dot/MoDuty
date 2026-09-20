import type { AgentPhase, AgentState, StreamEvent } from "./types.js";

/** 上下文指标对外 snake_case 结构（磁贴第二页数据） */
export interface ContextStatsSnake {
  prompt_tokens: number;
  context_window: number;
  cached_tokens: number | null;
  updated_at: string;
}

export interface AgentStateEvent {
  type: "agent_state";
  agent_id: string;
  state: AgentState;
  phase?: AgentPhase;
  /** 状态广播附带的最新名字（空名字创建的 Agent 首条对话后自动命名时用） */
  name?: string;
  /** 状态广播附带的最新上下文占用指标（snake 化，磁贴第二页用） */
  context_stats?: ContextStatsSnake;
}

export type AgentStateListener = (event: AgentStateEvent) => void;

/** @deprecated 已无选项（completedHoldMs 随定时器自转移一并删除）；仅为兼容旧调用方保留 */
export interface AgentStateMachineOptions {}

interface AgentRuntimeState {
  state: AgentState;
  phase?: AgentPhase;
}

/**
 * Agent 生命周期状态机（纯内存，不落盘；**仅为磁贴 UI 投影**）。
 *
 * 状态图：
 *   idle/completed/error ──新事件(token/tool_start)──▶ running(phase 流转)
 *   running ──approval_requested──▶ waiting_approval
 *   running ──question_requested──▶ requiring_input
 *   running ──done──▶ completed（稳定终态；下轮 chat 首个事件转回 running）
 *   任意 ──异常──▶ error；用户取消 ──▶ idle
 *
 * 注意：业务触发（值日生收尾判读等）**不得**订阅本状态机——那类事实源是派发台账
 * （dispatch-ledger）。本机只服务 UI 展示与 pending approval/input 的挂起语义。
 *
 * phase 由 StreamEvent 推导：首轮 token → planning；tool_start 按工具名
 * 分流 searching/reading/executing；纯文本执行 → executing/verifying。
 *
 * 状态变化通过 subscribe 的 listener 广播 {type:"agent_state",...}；
 * 持久化由订阅方（http 层）负责。
 */
export class AgentStateMachine {
  private readonly states = new Map<string, AgentRuntimeState>();
  private readonly listeners = new Set<AgentStateListener>();

  constructor(_options: AgentStateMachineOptions = {}) {
    // 兼容保留空 options 形参（历史调用方传 completedHoldMs 已无效果）
  }

  subscribe(listener: AgentStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  seed(agentId: string, state: AgentState, phase?: AgentPhase): void {
    this.states.set(agentId, { state, ...(phase ? { phase } : {}) });
  }

  getState(agentId: string): AgentRuntimeState | undefined {
    return this.states.get(agentId);
  }

  /** 处理一条 SSE 流内事件，返回转移产物（无变化返回 null） */
  consumeEvent(agentId: string, event: StreamEvent): AgentStateEvent | null {
    const current = this.ensure(agentId);
    let next: AgentState = current.state;
    let nextPhase: AgentPhase | undefined = current.phase;

    switch (event.type) {
      case "token":
        if (current.state === "idle" || current.state === "completed") {
          next = "running";
        }
        if (current.state === "error") {
          next = "running";
        }
        if (next === "running") {
          nextPhase = nextPhase ?? "planning";
        }
        break;
      case "tool_start":
        if (current.state === "idle" || current.state === "completed" || current.state === "error") {
          next = "running";
        }
        if (current.state === "waiting_approval" || current.state === "requiring_input") {
          return null; // 等待人工决策/输入中忽略模型事件
        }
        nextPhase = phaseForTool(event.name);
        break;
      case "approval_requested":
        next = "waiting_approval";
        nextPhase = undefined;
        break;
      case "question_requested":
        next = "requiring_input";
        nextPhase = undefined;
        break;
    }

    if (next === current.state && nextPhase === current.phase) {
      return null;
    }
    return this.transition(agentId, next, nextPhase);
  }

  /** 流正常结束（http 层发 done 后调用）；completed 为稳定终态，UI 层自行决定展示 */
  complete(agentId: string): AgentStateEvent | null {
    if (this.getState(agentId)?.state === "completed") {
      return null;
    }
    return this.transition(agentId, "completed", undefined);
  }

  /** 流异常（http 层 catch 到错误后调用） */
  fail(agentId: string): AgentStateEvent | null {
    return this.transition(agentId, "error", undefined);
  }

  /** 用户取消 / 连接断开：直接回到 idle（不留 error、不触发 completed 轮转） */
  cancel(agentId: string): AgentStateEvent | null {
    return this.transition(agentId, "idle", undefined);
  }

  /** 审批决策：approved → running；rejected → idle */
  decide(agentId: string, decision: "approved" | "rejected"): AgentStateEvent | null {
    if (this.getState(agentId)?.state !== "waiting_approval") {
      return null;
    }
    return this.transition(agentId, decision === "approved" ? "running" : "idle", undefined);
  }

  /** 用户已提交问题答案：requiring_input → running（随后由 orchestration 续跑） */
  answerReceived(agentId: string): AgentStateEvent | null {
    if (this.getState(agentId)?.state !== "requiring_input") {
      return null;
    }
    return this.transition(agentId, "running", undefined);
  }

  /**
   * 显式复位（窗口"重试"第一步）：非运行态的人工清理入口。
   * error / waiting_approval / requiring_input / completed → idle；running 与 idle 不动（running 正在执行不可复位）。
   */
  reset(agentId: string): AgentStateEvent | null {
    const current = this.getState(agentId);
    if (!current || current.state === "idle" || current.state === "running") {
      return null;
    }
    return this.transition(agentId, "idle", undefined);
  }

  dispose(): void {
    this.states.clear();
  }

  /** 删除 Agent 时丢弃其内存态（不再广播） */
  drop(agentId: string): void {
    this.states.delete(agentId);
  }

  private ensure(agentId: string): AgentRuntimeState {
    let current = this.states.get(agentId);
    if (!current) {
      current = { state: "idle" };
      this.states.set(agentId, current);
    }
    return current;
  }

  private transition(agentId: string, state: AgentState, phase: AgentPhase | undefined): AgentStateEvent {
    const record: AgentRuntimeState = { state, ...(phase ? { phase } : {}) };
    this.states.set(agentId, record);
    const event: AgentStateEvent = {
      type: "agent_state",
      agent_id: agentId,
      state,
      ...(phase ? { phase } : {}),
    };
    for (const listener of [...this.listeners]) {
      listener(event);
    }
    return event;
  }
}

function phaseForTool(toolName: string): AgentPhase {
  const name = toolName.toLowerCase();
  if (name.includes("search")) {
    return "searching";
  }
  if (name.includes("read") || name.includes("list")) {
    return "reading";
  }
  if (name.includes("write") || name.includes("shell") || name.includes("append")) {
    return "executing";
  }
  return "executing";
}