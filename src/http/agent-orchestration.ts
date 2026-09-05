import type { MomokaAgentCore } from "../agent.js";
import type { AgentRegistry } from "../agent-registry.js";
import type { AgentStateMachine, AgentStateEvent } from "../agent-state.js";
import type { WorkspaceManager } from "../workspace-manager.js";
import type { AgentRecord } from "../types.js";
import type { RouteContext } from "./route-context.js";
import { ensureAgents } from "./route-context.js";
import { isFullyAutomatic } from "../permission-mode.js";
import { contextStatsToSnake } from "./serialization.js";
import type { AgentEventBroadcaster } from "./sse.js";

/**
 * Agent 编排层：http handler 与状态机之间的粘合逻辑集中在这里。
 *
 * 职责（Proma AgentOrchestrator 对应物）：
 * - 状态转移 → 持久化注册表 + SSE 广播；
 * - 审批事件 → 驱动状态机脱离 waiting_approval，批准后异步续跑；
 * - pending approval 检查（决定 chat 流结束时 complete 还是保持等待）。
 *
 * AgentStateMachine 本身保持纯内存、无 IO；不要把这里的逻辑塞回状态机或 http handler。
 */

export interface OrchestrationDeps {
  agent: MomokaAgentCore;
  registry: AgentRegistry;
  machine: AgentStateMachine;
  broadcaster: AgentEventBroadcaster;
  workspaces: WorkspaceManager;
}

export function orchestrationOf(ctx: RouteContext): OrchestrationDeps {
  const { registry, machine } = ensureAgents(ctx);
  return { agent: ctx.agent, registry, machine, broadcaster: ctx.broadcaster, workspaces: ctx.workspaces };
}

/** 全局编排：任何状态/phase 转移 → 持久化注册表 + 广播给 /api/agents/events 的客户端 */
export function wireAgentStatePersistence(deps: OrchestrationDeps): void {
  deps.machine.subscribe((event) => {
    // 后台 fire-and-forget：持久化/广播失败不能炸掉服务进程（例如目录已被清理的竞态）
    void persistAgentState(deps, event).catch((error: unknown) => {
      console.error("[orchestration] persist agent state failed:", error);
    });
    // 值日生派发回调：执行者 completed/error 时向 dispatcher 会话投递结果链接
    void deliverDispatchNotification(deps, event).catch((error: unknown) => {
      console.error("[orchestration] deliver dispatch notification failed:", error);
    });
  });
}

/**
 * 派发回调投递：目标执行者状态进入终态（completed/error）时，若台账中有值日生的在途派发，
 * 向值日生会话写入一条系统消息（含 &ses_ 链接，前端渲染为可点击 chip）。
 * - completed → 投递“成功”并把该派发标记 done（停止跟踪）；
 * - error → 投递“出错”但仍保持 tracking，后续该执行者再跑再出错/成功会继续投递，直到 completed。
 */
async function deliverDispatchNotification(deps: OrchestrationDeps, event: AgentStateEvent): Promise<void> {
  if (event.type !== "agent_state") return;
  if (event.state !== "completed" && event.state !== "error") return;
  const active = await deps.registry.activeDispatchesForTarget(event.agent_id);
  if (active.length === 0) return;
  const target = await deps.registry.getAgent(event.agent_id);
  const targetName = target?.name ?? event.agent_id;
  for (const dispatch of active) {
    const sessionId = dispatch.dispatcherSessionId;
    if (!sessionId) continue;
    const isSuccess = event.state === "completed";
    const sessionRef = `&ses_${dispatch.targetSessionId.replace(/^ses_/, "")}`;
    const statusIcon = isSuccess ? "✅" : "❌";
    const actionText = isSuccess ? "已成功完成" : "出错（可点击查看原因，需要我处理请告诉我）";
    // role=system：历史中会以 [system] 片段呈现给值日生，作为可感知的“投递通知”而非用户指令
    await deps.agent.sessionManager.addMessage(sessionId, "system", `${statusIcon} 你派发的执行者「${targetName}」${actionText}：${sessionRef}`);
    await deps.registry.updateDispatchStatus(dispatch.id, event.state, isSuccess);
  }
}

async function persistAgentState(deps: OrchestrationDeps, event: AgentStateEvent): Promise<void> {
  const updated = await deps.registry.updateAgentState(event.agent_id, event.state, event.phase);
  const payload: AgentStateEvent = {
    ...event,
    ...(updated?.contextStats ? { context_stats: contextStatsToSnake(updated.contextStats) } : {}),
  };
  deps.broadcaster.broadcast(`data: ${JSON.stringify(payload)}\n\n`);
}

/** 检查某 Agent 绑定的 workspace 是否有待决审批（pending_approval 时不 complete） */
export async function checkHasPendingApproval(workspaces: WorkspaceManager, record: AgentRecord): Promise<boolean> {
  // 完全自动模式：不产生人工审批，遗留 pending 也不阻塞任务完结
  if (isFullyAutomatic()) {
    return false;
  }
  return await workspaces.hasPendingApproval(record.workspaceDir);
}

/**
 * 审批通过后续跑：把工具结果交给模型继续推理（从断点继续，不是从头跑）。
 * 异步执行，不阻塞审批响应；失败时状态机转 error。
 */
export async function resumeAgentAfterApproval(deps: OrchestrationDeps, record: AgentRecord): Promise<void> {
  try {
    await deps.agent.chat({
      message: "审批已通过。请根据工具执行结果继续完成任务。",
      sessionId: record.sessionId,
      onEvent: (event) => {
        deps.machine.consumeEvent(record.id, event);
      },
    });
    deps.machine.complete(record.id);
  } catch (error) {
    console.error("[resume] 审批后续跑失败:", error);
    deps.machine.fail(record.id);
  }
}

/**
 * 审批决策的 Agent 联动：审批事件若绑定某 Agent 的 session，
 * 驱动其状态机脱离 waiting_approval；批准则异步续跑。
 */
export async function driveApprovalDecision(
  deps: OrchestrationDeps,
  sessionId: string,
  decision: "approved" | "rejected",
): Promise<void> {
  const bound = (await deps.registry.listAgents()).find((candidate) => candidate.sessionId === sessionId);
  if (!bound) {
    return;
  }
  deps.machine.decide(bound.id, decision);
  if (decision === "approved") {
    void resumeAgentAfterApproval(deps, bound);
  }
}
