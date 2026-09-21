/**
 * OS 级提醒：Agent 需要用户拍板 / 输入时把用户叫回来。
 *
 * 分层策略（同一份调用，两种宿主都能用）：
 * 1. Tauri 壳内：`@tauri-apps/api/notification` → Windows 原生 Toast
 *    （需要 tauri.conf.json 的 allowlist.notification 与 Cargo feature "notification"）；
 * 2. 浏览器（vite dev / http://localhost:5173）：Web Notification API，由 Chrome/Edge 落成 Windows 原生通知；
 * 3. 两者都不可用：静默降级（只写 console），绝不阻塞对话主流程。
 *
 * 权限只申请一次；被拒绝后不再重复询问。
 */

let permissionAsked = false;

/**
 * 通知权限：Chrome/Edge 规定 requestPermission() 必须在用户手势里调用，否则直接返回 default 且连权限气泡都不弹。
 * 旧实现只在「要发通知的那一刻」申请（那里不在手势里）→ 永远拿不到权限 → 通知永远静默失败。
 * 现在两条腿走路：启动时挂一次性手势监听提前申请（见 primeNotificationPermission），
 * 发通知时再兜一次（已授权则直接通过）。
 */
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

/** 当前通知能力：给 UI 判断「能不能弹系统提示」（browser 未授权 / shell 不支持时为 false） */
export function notificationCapability(): "granted" | "default" | "denied" | "unsupported" {
  if (typeof Notification === "undefined") return "unsupported";
  return Notification.permission;
}

/** 是否跑在 Tauri 壳里（v1 注入 window.__TAURI__；纯 ESM 场景只有 IPC 全局对象） */
function inTauri(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __TAURI__?: unknown; __TAURI_IPC__?: unknown };
  return Boolean(w.__TAURI__ || w.__TAURI_IPC__);
}

async function notifyViaTauri(title: string, body: string): Promise<boolean> {
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import("@tauri-apps/api/notification");
    let granted = await isPermissionGranted();
    if (!granted && !permissionAsked) {
      permissionAsked = true;
      granted = (await requestPermission()) === "granted";
    }
    if (!granted) return false;
    sendNotification({ title, body });
    return true;
  } catch {
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
  /** 提醒去重键：同一个 tag 的新提醒会替换旧的（建议按 Agent 区分） */
  tag?: string;
  /** 用户点击提醒时的回调（用于打开对应 Agent 窗口并聚焦） */
  onClick?: () => void;
}

/** 发一条 OS 级提醒；返回是否真的送出（失败不抛异常） */
export async function notifyNative(options: NativeNotifyOptions): Promise<boolean> {
  const { title, body, tag = "moduty", onClick } = options;
  if (inTauri()) {
    const viaTauri = await notifyViaTauri(title, body);
    if (viaTauri) return true;
  }
  return await notifyViaWeb(title, body, tag, onClick);
}
