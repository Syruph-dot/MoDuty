/**
 * 「Agent 在等你」提醒的总闸：判定、去重、冷却、打开窗口集中在这里，实际投递走 lib/nativeNotify
 * （Tauri 内是 Windows 原生 Toast，浏览器内是 Web Notification）。
 *
 * 两条触发路径（缺一不可）：
 * 1. 事件驱动：SSE 收到某 Agent 进入 requiring_input（待答提问）/ waiting_approval（待审批）→ raiseAgentAlert；
 * 2. 启动对账：应用没开着的时候 Agent 就已经挂起了（转移事件早丢了）→ catchUpAgentAlerts 开机补一次。
 *    这是「明明有待答提问，却什么提示都没有」的常见成因，光靠事件流补不回来。
 *
 * 抑制与去重：
 * - 该 Agent 的窗口已经打开且页面可见 → 不打扰（卡片就在眼前）；
 * - 同一 (Agent, 状态) 只提醒一次，直到它脱离挂起态（避免事件抖动把同一件事反复弹）；
 * - 额外 60s 冷却，兜住短期重复事件。
 */
import { listAgents } from "./api";
import { deriveVisibleAgents } from "./agentFilter";
import { notifyNative } from "./nativeNotify";
import { ensureAgentInList, useAgentsStore } from "../state/agentsStore";
import { useDialogStore } from "../state/dialogStore";

export type AgentAlertState = "requiring_input" | "waiting_approval";

const NOTIFY_COOLDOWN_MS = 60_000;

/** 已经提醒过的 `<agentId>:<state>`；Agent 脱离挂起态时清掉，允许下次再提醒 */
const raisedKeys = new Set<string>();
const lastNotifyAt = new Map<string, number>();

function alertTitle(name: string, state: AgentAlertState): string {
  return state === "requiring_input" ? `${name} 在等你回答` : `${name} 在等审批`;
}

function alertBody(state: AgentAlertState): string {
  return state === "requiring_input"
    ? "有一条提问等你作答，回到 MoDuty 选一项或输入自定义答案即可。"
    : "有一条待审批的操作，回到 MoDuty 即可处理。";
}

/** 该 Agent 的窗口已经开着且页面在看 → 不打扰 */
export function isAgentWindowInFront(agentId: string): boolean {
  if (typeof document === "undefined") return false;
  const store = useAgentsStore.getState();
  return store.openAgentIds.includes(agentId) && document.visibilityState === "visible";
}

/** 记一次「Agent 在等你」：去重 + 冷却后发系统通知 */
export function raiseAgentAlert(input: { agentId: string; name?: string; state: AgentAlertState }): void {
  const { agentId, state } = input;
  if (!agentId || isAgentWindowInFront(agentId)) return;
  const name =
    input.name?.trim() ||
    useAgentsStore.getState().agents.find((candidate) => candidate.id === agentId)?.name ||
    "有 Agent";
  const key = `${agentId}:${state}`;

  if (raisedKeys.has(key)) return;
  raisedKeys.add(key);

  const now = Date.now();
  if (now - (lastNotifyAt.get(key) ?? 0) < NOTIFY_COOLDOWN_MS) return;
  lastNotifyAt.set(key, now);

  void notifyNative({
    title: alertTitle(name, state),
    body: alertBody(state),
    tag: `moduty-agent-${agentId}`,
    // 通知上直接给一个入口按钮：点了由 Rust 回传 action，前端负责把窗口开出来
    actions: [{ id: `open-agent:${agentId}`, label: "打开窗口" }],
    onClick: () => {
      void openAgentFromAlert(agentId).then(() => window.focus());
    },
  });
}

/** Agent 脱离挂起态（已作答 / 已审批）：允许下次再提醒 */
export function clearAgentAlert(agentId: string): void {
  for (const key of [...raisedKeys]) {
    if (key.startsWith(`${agentId}:`)) {
      raisedKeys.delete(key);
      lastNotifyAt.delete(key);
    }
  }
}

/**
 * 打开该 Agent 的窗口（浏览器分支点通知时调用；Tauri 分支的点击行为由 Windows 接管）。
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
