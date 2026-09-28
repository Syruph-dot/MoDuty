import fs from "node:fs";
import path from "node:path";

/**
 * 发行版 sidecar 入口：同一个 exe 既当后端服务，也当 momoka CLI。
 *
 * 为什么必须兼顾 CLI：打包版没有 Node，`run_momoka_cli` 工具的 spawn 目标是
 * `process.execPath`（就是本 exe）。如果本入口无论有没有参数都启动服务，那么
 * 任何一次 CLI 子命令都会变成「再起一个后端」——被占用的 8888 会立刻报
 * “Port 8888 is already in use”，值日生连执行者都建不出来（2026-09-28 实测）。
 */

const args = process.argv.slice(2);

if (args.length > 0) {
  // CLI 模式：与 bin/momoka.mjs 读取 argv 的方式一致（它自己 slice(2)）
  await import("../bin/momoka.mjs");
} else {
  const executableDirectory = path.dirname(process.execPath);
  const roots = [
    process.env.MOMOKA_PROJECT_ROOT,
    path.resolve(executableDirectory, ".."),
    executableDirectory,
    path.resolve(executableDirectory, "resources"),
    path.resolve(executableDirectory, "..", "resources"),
    process.cwd(),
  ].filter((value): value is string => Boolean(value));
  const projectRoot = roots.find((root) => fs.existsSync(path.join(root, "prompts", "SYSTEM_RULES.md")));
  if (!projectRoot) throw new Error("Release resources are missing prompts/SYSTEM_RULES.md");

  process.env.MOMOKA_SERVER_NO_AUTOSTART = "1";
  const { createMomokaServer } = await import("../src/server.js");
  await createMomokaServer({ projectRoot, portFile: process.env.MOMOKA_PORT_FILE }).listen();
}
