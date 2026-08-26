// 本地开发启动器：显式调 createMomokaServer，避免 node --import tsx src/server.js
// 走 process.argv[1] 自检失败路径。
import { createMomokaServer } from "./src/server.js";

createMomokaServer({
  port: Number(process.env.PORT ?? 8888),
  host: process.env.HOST ?? "127.0.0.1",
}).listen().then(({ port, host }) => {
  console.log(`[dev-server] listening on http://${host}:${port}`);
}).catch((err) => {
  console.error("[dev-server] failed:", err);
  process.exit(1);
});
