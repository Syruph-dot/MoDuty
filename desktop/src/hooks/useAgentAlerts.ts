import { useEffect } from "react";

import { catchUpAgentAlerts, clearAgentAlert, openAgentFromAlert, raiseAgentAlert } from "../lib/agentAlerts";
import { subscribeDutyEvents } from "../lib/dutyEvents";
import { listenToastActions, notifyNative, primeNotificationPermission } from "../lib/nativeNotify";
import { useDialogStore } from "../state/dialogStore";

/** 通知按钮的 action id → 动作 */
const DUTY_ACTION = "open-duty";
const AGENT_ACTION_PREFIX = "open-agent:";

/**
 * 系统通知接线：把两类事件翻译成 Windows 原生通知（Tauri 内）或浏览器通知，并把
 * 通知按钮的点击接回应用。
 *
 * 1. Agent 需要你介入（requiring_input / waiting_approval）→ lib/agentAlerts（带去重与冷却）；
 * 2. 值日生判读上报（dispatch_verdict）→ 直接投递，判读本身就是一次性的结论播报。
 *
 * 启动时再对账一次：应用没开着时 Agent 就已经挂起了（转移事件早丢了），光靠事件流补不回来。
 */
export function useAgentAlerts(): void {
  useEffect(() => {
    // 浏览器要在用户手势里才能拿到通知权限；顺手在第一次点击/按键时申请
    primeNotificationPermission();
    // 开机补一次：现在就在等你的 Agent（事件早丢了也不会漏）
    void catchUpAgentAlerts();

    const unsubscribeEvents = subscribeDutyEvents((event) => {
      if (event.type === "dispatch_verdict") {
        void notifyNative({
          title: event.verdict === "deliver" ? "值日生上报：任务可交付" : `值日生：已安排返工（${event.continue_count}/3）`,
          body: `${event.task}${event.note ? ` — ${event.note}` : ""}`,
          tag: `moduty-verdict-${event.dispatch_id}`,
          actions: [{ id: DUTY_ACTION, label: "打开值日生页" }],
        });
        return;
      }
      if (event.type !== "agent_state") return;
      const { state, agent_id: agentId } = event;
      if (state === "requiring_input" || state === "waiting_approval") {
        raiseAgentAlert({ agentId, name: event.name, state });
        return;
      }
      // 脱离挂起态（已作答/已审批/重跑）：允许下次再提醒
      clearAgentAlert(agentId);
    });

    // 通知按钮被点：把对应窗口开出来（订阅是异步建立的，卸载时可能还没拿到 unlisten）
    let disposed = false;
    let unsubscribeActions: (() => void) | undefined;
    void listenToastActions((actionId) => {
      if (actionId === DUTY_ACTION) {
        useDialogStore.getState().openDuty();
        return;
      }
      if (actionId.startsWith(AGENT_ACTION_PREFIX)) {
        void openAgentFromAlert(actionId.slice(AGENT_ACTION_PREFIX.length));
      }
    }).then((unlisten) => {
      if (disposed) unlisten();
      else unsubscribeActions = unlisten;
    });

    return () => {
      disposed = true;
      unsubscribeActions?.();
      unsubscribeEvents();
    };
  }, []);
}
