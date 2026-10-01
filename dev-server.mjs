// 本地开发启动器：显式调 createMomokaServer，避免 node --import tsx src/server.js
// 走 process.argv[1] 自检失败路径。
//
// 端口策略：PORT 显式给了就用它；没给则从 7238 起挑一个真正空闲的端口。
// 不能写死 8888 —— Windows 上强杀进程会留下归属已死 PID 的残留监听（实测 8888/8889），
// 写死端口的表现就是"启动即闪退"。但端口上若已有另一个 MOMOKA 实例，必须拒绝启动第二份。
import { createMomokaServer } from "./src/server.js";
import { defaultPortFile } from "./src/port-select.js";

const portFile = process.env.MOMOKA_PORT_FILE ?? defaultPortFile();

createMomokaServer({
  port: process.env.PORT ? Number(process.env.PORT) : undefined,
  host: process.env.HOST ?? "127.0.0.1",
  portFile,
}).listen().then(({ port, host }) => {
  console.log(`[dev-server] listening on http://${host}:${port}`);
  console.log(`[dev-server] port file: ${portFile}`);
}).catch((err) => {
  console.error("[dev-server] failed:", err instanceof Error ? err.message : err);
  // 用 exitCode 而不是 process.exit()：拒绝启动时可能还有正在关闭的 socket/timer，
  // 硬退出会触发 libuv 的 UV_HANDLE_CLOSING 断言（噪音）。事件循环一空进程自然退出。
  process.exitCode = 1;
});
