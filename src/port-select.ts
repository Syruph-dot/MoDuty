/**
 * 端口挑选：区分「空闲」「已有 MOMOKA 在跑」「被别的东西占着」。
 *
 * 为什么要区分，而不是简单地"占用了就往上加一个端口"：
 * - 两个后端并存会并发写同一份 agents.json（无文件锁），这是注册表被清空/损坏的根因，
 *   所以端口上**已经有一个 MOMOKA 实例时必须拒绝再起一个**；
 * - 但被幽灵监听（进程被强杀后 Windows 上残留的监听，`bind` 会报 EACCES/EADDRINUSE，
 *   而 PID 早已不存在）或 Docker/别的服务占着的端口，**没有多实例风险**，直接跳过用下一个即可。
 *   实际踩过：8888/8889 被幽灵占着，dev 后端写死 8888 就"启动即闪退"。
 */
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT_BASE = 8888;
export const DEFAULT_PORT_TRIES = 10;

/** 后端真实监听的端口写在这里；桌面壳与 dev 前端都读它。 */
export function defaultPortFile(): string {
  return path.join(os.tmpdir(), "arona-chest.momoka.port");
}

export type PortStatus = "free" | "momoka" | "other";

export interface PortPick {
  kind: "free" | "momoka" | "none";
  /** kind === "free" 时可用；kind === "momoka" 时指向已存在的实例 */
  port?: number;
  /** 跳过的端口及原因，用于打印给人看 */
  skipped: { port: number; status: Exclude<PortStatus, "free">; detail: string }[];
}

/** 能不能在这个端口上 bind（能 bind 就是空闲）。 */
function canBind(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    // 只在真的 listening 之后才 close：从没 listen 成功的 server 去 close，
    // 会在进程退出时触发 libuv 的 UV_HANDLE_CLOSING 断言（噪音、且难定位）。
    probe.once("error", () => resolve(false));
    probe.once("listening", () => {
      probe.close(() => resolve(true));
    });
    try {
      probe.listen(port, host);
    } catch {
      resolve(false);
    }
  });
}

/** 该端口上是不是一个健康的 MOMOKA 后端（只看 /api/health 的响应体，别把 200 当自己人）。 */
async function isMomoka(port: number, host: string): Promise<boolean> {
  const probeHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  try {
    const response = await fetch(`http://${probeHost}:${port}/api/health`, {
      signal: AbortSignal.timeout(600),
    });
    if (!response.ok) return false;
    const text = await response.text();
    return text.includes("MOMOKA");
  } catch {
    return false;
  }
}

export async function inspectPort(port: number, host: string): Promise<PortStatus> {
  if (await canBind(port, host)) return "free";
  return (await isMomoka(port, host)) ? "momoka" : "other";
}

/**
 * 从 `base` 起找一个可用端口。
 *
 * 两轮扫描，顺序很重要：**先确认整个区间内没有已在运行的 MOMOKA**，再挑第一个空闲端口。
 * 如果边扫边挑，一旦前面就有空闲端口，就会在“另一个实例已经跑在后面端口上”的情况下
 * 愉快地再起一份——两份实例会并发写同一份 agents.json。
 *
 * - 区间内有健康 MOMOKA → `{ kind: "momoka", port }`（调用方应当拒绝启动第二个）
 * - 没有 MOMOKA、有空闲 → `{ kind: "free", port }`
 * - 一路都是别的占用 → `{ kind: "none", skipped }`
 */
export async function pickPort(options: {
  base?: number;
  tries?: number;
  host?: string;
} = {}): Promise<PortPick> {
  const base = options.base ?? DEFAULT_PORT_BASE;
  const tries = Math.max(1, options.tries ?? DEFAULT_PORT_TRIES);
  const host = options.host ?? "127.0.0.1";
  const skipped: PortPick["skipped"] = [];
  const candidates: number[] = [];
  for (let offset = 0; offset < tries; offset += 1) {
    candidates.push(base + offset);
  }
  const statuses: PortStatus[] = [];
  for (const port of candidates) {
    statuses.push(await inspectPort(port, host));
  }
  const existing = candidates.find((_, index) => statuses[index] === "momoka");
  if (existing !== undefined) {
    return { kind: "momoka", port: existing, skipped };
  }
  for (let index = 0; index < candidates.length; index += 1) {
    const port = candidates[index];
    if (statuses[index] === "free") return { kind: "free", port, skipped };
    skipped.push({
      port,
      status: "other",
      detail: "被占用但响应不是 MOMOKA（可能是强杀进程留下的残留监听，或别的服务）",
    });
  }
  return { kind: "none", skipped };
}

/** 打印跳过情况，别让"换了个端口"悄悄发生。 */
export function describeSkipped(skipped: PortPick["skipped"]): string {
  if (skipped.length === 0) return "";
  return skipped.map((item) => `  - ${item.port}: ${item.detail}`).join("\n");
}
