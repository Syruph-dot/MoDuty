/**
 * OS 级提醒：把"需要你介入 / 有结果了"送到 Windows 通知中心。
 *
 * 两条腿（同一份调用，两种宿主都能用）：
 * 1. Tauri 壳内：invoke `notify_toast` → Rust 侧直接发 Windows 原生 Toast。
 *    为什么不用 `@tauri-apps/api/notification`：tauri 1.8.3 在 exe 位于 `target\debug|release`
 *    时会**跳过 AppUserModelID**，而 Windows 对没有 AUMID 的未打包进程发来的 toast 是静默丢弃的
 *    （不报错、不显示）—— 这就是"通知是假的"的真因。Rust 侧自己维护 AUMID 之后不再依赖它。
 * 2. 浏览器（vite dev / 直接开 http://localhost:6429）：Web Notification API，由 Chrome/Edge
 *    落成 Windows 原生通知。Chromium 规定 requestPermission() 必须在用户手势里调用，
 *    否则直接返回 default 连权限气泡都不弹，所以启动时挂一次性手势监听（primeNotificationPermission）。
 * 3. 两者都不可用：静默降级（只写 console），绝不阻塞对话主流程。
 */

let permissionAsked = false;

/** 浏览器通知权限：必须在用户手势里提前申请，发通知那一刻再申请永远拿不到。 */
export function primeNotificationPermission(): void {
  if (typeof window === "undefined" || typeof Notification === "undefined") return;
  if (Notification.permission !== "default") return;
  const ask = (): void => {
    cleanup();
    if (permissionAsked) return;
    permissionAsked = true;
    void Notification.requestPermission().catch(() => undefined);
  };
  const cleanup = (): void => {
    window.removeEventListener("pointerdown", ask, true);
    window.removeEventListener("keydown", ask, true);
  };
  window.addEventListener("pointerdown", ask, true);
  window.addEventListener("keydown", ask, true);
}

/** 当前通知能力：给 UI 判断「能不能弹系统提示」（浏览器未授权 / 宿主不支持时为 unsupported） */
export function notificationCapability(): "granted" | "default" | "denied" | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** 是否跑在 Tauri 壳里（v2 注入 __TAURI_INTERNALS__；v1 是 __TAURI__ / __TAURI_IPC__） */
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return "__TAURI_INTERNALS__" in w || "__TAURI__" in w || "__TAURI_IPC__" in w;
}

async function notifyViaTauri(title: string, body: string, actions: NotifyAction[]): Promise<boolean> {
  try {
    // 动态 import：避免 vite 浏览器构建时把 @tauri-apps/api 拉进主包
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("notify_toast", { title, body, actions });
    return true;
  } catch (error) {
    console.warn("[notify] Tauri 通知发送失败：", error);
    return false;
  }
}

async function notifyViaWeb(title: string, body: string, tag: string, onClick?: () => void): Promise<boolean> {
  if (typeof Notification === "undefined") return false;
  try {
    if (Notification.permission === "denied") return false;
    if (Notification.permission === "default") {
      // 不在手势里时这次会静默失败，但没有副作用；拿到权限的时机靠 primeNotificationPermission
      const result = await Notification.requestPermission().catch(() => "default" as NotificationPermission);
      if (result !== "granted") return false;
    }
    // tag 相同 → 同一 Agent 的旧提醒被替换而不是堆叠
    const notification = new Notification(title, { body, tag });
    if (onClick) {
      notification.onclick = () => {
        onClick();
        notification.close();
      };
    }
    return true;
  } catch {
    return false;
  }
}

export interface NativeNotifyOptions {
  title: string;
  body: string;
  /** 提醒去重键（浏览器分支用它替换同类提醒；Tauri 分支由 Windows 自己管理） */
  tag?: string;
  /**
   * 通知上的按钮（仅 Tauri 分支生效）。按钮被点后由 `listenToastActions` 回传 action id。
   * Windows 的 toast 最多放 5 个按钮。
   */
  actions?: NotifyAction[];
  /** 用户点击提醒时的回调（仅浏览器分支可用） */
  onClick?: () => void;
}

/** 通知上的一个按钮 */
export interface NotifyAction {
  /** 回传给前端的事件 id，例如 `open-agent:agt_xxx` */
  id: string;
  label: string;
}

/** 发一条系统通知；返回是否真的送出（失败不抛异常） */
export async function notifyNative(options: NativeNotifyOptions): Promise<boolean> {
  const { title, body, tag = "moduty", actions = [], onClick } = options;
  if (inTauri()) {
    const viaTauri = await notifyViaTauri(title, body, actions);
    if (viaTauri) return true;
  }
  return await notifyViaWeb(title, body, tag, onClick);
}

/**
 * 监听「通知按钮被点」：Rust 侧收到 WinRT 激活回调后把 action id 发过来（仅 Tauri 分支）。
 * 返回取消监听的函数（订阅尚未建立时调用也安全）。
 */
export async function listenToastActions(handler: (actionId: string) => void): Promise<() => void> {
  if (!inTauri()) return () => undefined;
  try {
    const { listen } = await import("@tauri-apps/api/event");
    const unlisten = await listen<{ action: string }>("moduty-toast-action", (event) => {
      const action = event.payload?.action;
      if (action) handler(action);
    });
    return unlisten;
  } catch (error) {
    console.warn("[notify] 订阅通知按钮事件失败：", error);
    return () => undefined;
  }
}
