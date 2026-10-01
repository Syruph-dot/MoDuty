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
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";

export const DEFAULT_PORT_BASE = 7238;
export const DEFAULT_PORT_TRIES = 10;

/** 后端真实监听的端口写在这里；桌面壳与 dev 前端都读它。 */
export function defaultPortFile(): string {
  return path.join(os.tmpdir(), "arona-chest.momoka.port");
}

export type PortStatus = "free" | "momoka" | "other";

/** 被跳过的一个端口（预检或真实 listen 发现不能用）。 */
export interface PortSkip {
  port: number;
  status: Exclude<PortStatus, "free">;
  detail: string;
}

export interface PortPick {
  kind: "free" | "momoka" | "none";
  /** kind === "free" 时可用；kind === "momoka" 时指向已存在的实例 */
  port?: number;
  /** 跳过的端口及原因，用于打印给人看 */
  skipped: PortSkip[];
}

/**
 * 能不能在这个端口上 bind（能 bind 就是空闲）。
 *
 * 这里用 `node:http` 的 server，而不是 `node:net`：探针必须和**真正要用的那个
 * server**是同一种，否则探针的结论可以合法地和 listen 不一致。
 * 2026-10-01 实测（Bun 1.3.8 / Windows）：别的进程占着 `127.0.0.1:8889` 时，
 * `node:net` 的 `listen(8889, "0.0.0.0")` **成功**，而 `node:http` 的同名调用报
 * EADDRINUSE。打包版 sidecar 跑在 Bun 上，于是"预检说空闲 → 挑中 → 真 listen 失败"，
 * 表现就是 `momoka-server.exe` 启动即闪退。
 */
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
 * 从 `base` 起勘察一遍端口区间。
 *
 * 两轮扫描，顺序很重要：**先确认整个区间内没有已在运行的 MOMOKA**，再挑第一个空闲端口。
 * 如果边扫边挑，一旦前面就有空闲端口，就会在“另一个实例已经跑在后面端口上”的情况下
 * 愉快地再起一份——两份实例会并发写同一份 agents.json。
 *
 * 用法约定：`kind === "momoka"` 是硬结论（必须拒绝启动第二份）；而 `kind === "free"`
 * 只是**预检意见**，调用方拿它当参考可以、当判据不行——起服务时要拿真正的 `listen`
 * 去确认（见 src/server.ts 的 listenOnFirstAvailable）。探针与真实 listen 之间没有
 * 任何东西能保证两边结论一致；2026-10-01 的打包版闪退就是信了预检的后果。
 *
 * - 区间内有健康 MOMOKA → `{ kind: "momoka", port }`（调用方应当拒绝启动第二个）
 * - 没有 MOMOKA、预检有空闲 → `{ kind: "free", port }`
 * - 预检一路都是别的占用 → `{ kind: "none", skipped }`
 */
export async function pickPort(options: {
  base?: number;
  tries?: number;
  host?: string;
} = {}): Promise<PortPick> {
  const base = options.base ?? DEFAULT_PORT_BASE;
  const tries = Math.max(1, options.tries ?? DEFAULT_PORT_TRIES);
  const host = options.host ?? "127.0.0.1";
  const skipped: PortSkip[] = [];
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
export function describeSkipped(skipped: readonly PortSkip[]): string {
  if (skipped.length === 0) return "";
  return skipped.map((item) => `  - ${item.port}: ${item.detail}`).join("\n");
}

/** 一次真实 listen 的结果：成功，或“端口被占”（可换端口重试）。其它错误直接抛出。 */
export type ListenAttempt = { kind: "listening" } | { kind: "busy"; code: string };

/**
 * 真的去 listen，而不是“先 bind 探一下”。
 *
 * 为什么挑端口最终必须落到这个操作上：预检会撒谎。2026-10-01 打包版闪退的根因就是它
 * ——Bun 在 Windows 上，`node:net` 的探测 bind 与 `node:http` 的 listen 结论不一致：
 * 别的进程占着 `127.0.0.1:8889` 时，net 探到 `0.0.0.0:8889`“能绑”，而真 listen 报
 * EADDRINUSE。于是“预检说空闲”的端口一用就死。
 * 让判断和使用变成同一个操作，两侧就不可能再打架。
 */
export function attemptListen(server: Server, port: number, host: string): Promise<ListenAttempt> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      if (err.code === "EADDRINUSE" || err.code === "EACCES") {
        // EACCES 在 Windows 上通常就是同一件事：旧进程被强杀后内核里残留的监听还在（PID 已消失）。
        resolve({ kind: "busy", code: err.code });
      } else {
        reject(new Error(`Failed to start server on port ${port}: ${err.message}`));
      }
    };
    const onListening = () => {
      server.off("error", onError);
      resolve({ kind: "listening" });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

/**
 * listen 失败后先把 server 复位，再换下一个端口重试。
 *
 * 实测（Node 24 / Bun 1.3.8，Windows）：**失败后直接重 listen 也是允许的**，
 * 这一步并不是必需的。保留它是因为 `ERR_SERVER_ALREADY_LISTEN` 是真实存在的错误
 * （已 listening 的实例再 listen 就抛），而重试路径上出现未处理 error 事件就是
 * 又一种“启动即闪退”。一次 close 换掉这个不确定性，很划算。
 */
function resetAfterFailedListen(server: Server): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      server.close(finish);
    } catch {
      finish();
    }
    // close 在“从未 listen 成功”时可能异步/不回调，兜住避免卡死（finish 幂等）
    setTimeout(finish, 250);
  });
}

/**
 * 在指定端口上监听；被占用则直接失败（多实例会写坏 agents.json，不能默默换端口）。
 * 这是 `PORT=` 显式指定时的语义：Tauri 壳自己挑好端口再传进来，端口不可用时它必须能立刻发现。
 */
export async function listenOnPort(server: Server, port: number, host: string): Promise<void> {
  const attempt = await attemptListen(server, port, host);
  if (attempt.kind === "listening") return;
  throw new Error(
    `Port ${port} is already in use (${attempt.code}). Another MOMOKA server instance may still be running, ` +
      `or a stale listening socket left behind by a killed process. ` +
      `Check it with \`netstat -ano | findstr :${port}\`: if that PID no longer exists, only a reboot frees the port; ` +
      `otherwise stop the instance or start on another port.`,
  );
}

/**
 * 从 `base` 起逐个**真正 listen**，被占用就换下一个。
 *
 * 这是“没显式给端口”时的挑选方式。为什么不先 bind 探一轮再挑：探针与真实 listen 会
 * 给出不同结论（见 attemptListen）。挑中探针说“空闲”的端口、真 listen 报 EADDRINUSE，
 * 就是打包版 `momoka-server.exe` 启动即闪退的完整因果链。
 */
export async function listenOnFirstAvailable(
  server: Server,
  base: number,
  tries: number,
  host: string,
): Promise<{ port: number; skipped: PortSkip[] }> {
  const skipped: PortSkip[] = [];
  for (let offset = 0; offset < Math.max(1, tries); offset += 1) {
    const port = base + offset;
    const attempt = await attemptListen(server, port, host);
    if (attempt.kind === "listening") return { port, skipped };
    skipped.push({ port, status: "other", detail: `真实 listen 被占用（${attempt.code}）` });
    await resetAfterFailedListen(server);
  }
  throw new Error(
    `从 ${base} 起的 ${Math.max(1, tries)} 个端口都监听不了：\n${describeSkipped(skipped)}\n` +
      `请用 PORT=<可用端口> 指定一个，或先释放占用。`,
  );
}
