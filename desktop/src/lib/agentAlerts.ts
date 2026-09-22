/**
 * 「Agent 在等你」提醒的总闸：桌面 toast + OS 通知共用一套判定与去重。
 *
 * 两条触发路径（缺一不可）：
 * 1. 事件驱动：SSE 收到某 Agent 进入 requiring_input（待答提问）/ waiting_approval（待审批）→ raiseAgentAlert；
 * 2. 启动对账：应用没开着的时候 Agent 就已经挂起了（转移事件早丢了）→ catchUpAgentAlerts 开机补一次。
 *    这是「明明有待答提问，却什么提示都没有」的常见成因，光靠事件流补不回来。
 *
 * 抑制与去重：
 * - 该 Agent 的窗口已经打开且页面可见 → 不打扰（卡片就在眼前）；
 * - toast 每个 (Agent, 状态) 只弹一次，直到它脱离挂起态（避免 5s 轮询把同一件事反复弹）；
 * - OS 通知同一 (Agent, 状态) 60s 冷却。
 */
import { listAgents } from "./api";
import { deriveVisibleAgents } from "./agentFilter";
import { notifyNative } from "./nativeNotify";
import { ensureAgentInList, useAgentsStore } from "../state/agentsStore";
import { useDialogStore } from "../state/dialogStore";

export type AgentAlertState = "requiring_input" | "waiting_approval";

export interface AgentAlert {
  /** 去重键：`<agentId>:<state>` */
  id: string;
  agentId: string;
  name: string;
  state: AgentAlertState;
  at: number;
}

export type AgentAlertEvent =
  | { type: "raise"; alert: AgentAlert }
  | { type: "dismiss"; agentId: string };

const NOTIFY_COOLDOWN_MS = 60_000;

const listeners = new Set<(event: AgentAlertEvent) => void>();
const lastNotifyAt = new Map<string, number>();
const raisedKeys = new Set<string>();

export function subscribeAgentAlerts(listener: (event: AgentAlertEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(event: AgentAlertEvent): void {
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch {
      // 单个订阅者异常不影响其它订阅者
    }
  }
}

function alertTitle(name: string, state: AgentAlertState): string {
  return state === "requiring_input" ? `${name} 在等你回答` : `${name} 在等审批`;
}

function alertBody(state: AgentAlertState): string {
  return state === "requiring_input"
    ? "有一条提问等你作答，在窗口里选一项或输入自定义答案即可。"
    : "有一条待审批的操作，打开窗口即可处理。";
}

/** 该 Agent 的窗口已经开着且页面在看 → 不打扰 */
export function isAgentWindowInFront(agentId: string): boolean {
  if (typeof document === "undefined") return false;
  const store = useAgentsStore.getState();
  return store.openAgentIds.includes(agentId) && document.visibilityState === "visible";
}

/** 记一次「Agent 在等你」：桌面 toast（每状态一次）+ OS 通知（60s 冷却） */
export function raiseAgentAlert(input: { agentId: string; name?: string; state: AgentAlertState }): void {
  const { agentId, state } = input;
  if (!agentId || isAgentWindowInFront(agentId)) return;
  const name =
    input.name?.trim() ||
    useAgentsStore.getState().agents.find((candidate) => candidate.id === agentId)?.name ||
    "有 Agent";
  const key = `${agentId}:${state}`;

  if (!raisedKeys.has(key)) {
    raisedKeys.add(key);
    emit({ type: "raise", alert: { id: key, agentId, name, state, at: Date.now() } });
  }

  const now = Date.now();
  if (now - (lastNotifyAt.get(key) ?? 0) < NOTIFY_COOLDOWN_MS) return;
  lastNotifyAt.set(key, now);
  void notifyNative({
    title: alertTitle(name, state),
    body: alertBody(state),
    tag: `moduty-agent-${agentId}`,
    onClick: () => {
      void openAgentFromAlert(agentId).then(() => window.focus());
    },
  });
}

/** Agent 脱离挂起态（已作答 / 已审批）：撤掉飘着的 toast，并允许下次再提醒 */
export function clearAgentAlert(agentId: string): void {
  let removed = false;
  for (const key of [...raisedKeys]) {
    if (key.startsWith(`${agentId}:`)) {
      raisedKeys.delete(key);
      lastNotifyAt.delete(key);
      removed = true;
    }
  }
  if (removed) emit({ type: "dismiss", agentId });
}

/**
 * 打开该 Agent 的窗口并收起提示（toast / OS 通知的点击动作）。
 *
 * 两个坑：
 * 1. 值日生不是磁贴实体（wall 派生时被排除），openAgent 对它是空操作 → 改成打开值日生页；
 * 2. 被归档（手动归档，或超出自定义活跃天数被自动归档）的 Agent 不在墙上，
 *    openAgent 只改打开集合、没有磁贴承载 → 点了像没反应。这里先让它回到墙上（都可在归档库里反悔）。
 */
export async function openAgentFromAlert(agentId: string): Promise<void> {
  // 后端新建的 Agent（值日生/机器人建的）可能还没进前端列表：拉一次再开，别点了没反应
  await ensureAgentInList(agentId);
  const store = useAgentsStore.getState();
  const agent = store.agents.find((candidate) => candidate.id === agentId);
  if (agent?.kind === "dispatcher") {
    useDialogStore.getState().openDuty();
    clearAgentAlert(agentId);
    return;
  }
  if (agent) {
    const onWall = deriveVisibleAgents(store.agents, store.filters, {
      pinnedIds: store.pinnedIds,
      archivedIds: store.archivedIds,
      archiveDays: store.archiveDays,
    }).wall.some((candidate) => candidate.id === agentId);
    if (!onWall) {
      if (store.archivedIds.includes(agentId)) store.toggleArchive(agentId);
      else store.togglePin(agentId);
    }
  }
  store.openAgent(agentId);
  clearAgentAlert(agentId);
}

/**
 * 启动对账：把「现在就在等你」的 Agent 补一次提醒。
 * 只补挂起态，不补历史；失败（后端没起来）静默跳过，等下次事件即可。
 */
export async function catchUpAgentAlerts(): Promise<number> {
  try {
    const agents = await listAgents();
    let count = 0;
    for (const agent of agents) {
      if (agent.state !== "requiring_input" && agent.state !== "waiting_approval") continue;
      raiseAgentAlert({ agentId: agent.id, name: agent.name, state: agent.state });
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}
