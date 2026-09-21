/**
 * 子进程输出解码：Windows 控制台/系统工具（cmd、PowerShell、esptool 等）默认
 * 输出 CP936/GBK，直接 toString("utf8") 会把中文变成乱码（��Ϣ 之类）。
 * POSIX 平台保持 UTF-8。
 */
export function decodeCommandOutput(buffer: Buffer): string {
  if (process.platform === "win32") {
    // Node ≥18 / Bun 均内置 ICU，支持 gbk/gb18030
    return new TextDecoder("gbk").decode(buffer);
  }
  return buffer.toString("utf8");
}

/**
 * 我们自己起的 Node 子进程（MoDuty CLI：`node bin/momoka.mjs`）的输出解码。
 *
 * **不能走 decodeCommandOutput**：那个是按 Windows 控制台代码页（GBK）解的，
 * 而 Node 往管道里写的一律是 **UTF-8 字节**（Node 自己的流永远是 UTF-8，
 * 与控制台代码页无关）。按 GBK 解就会变成：
 *
 *   “MOMOKA CLI v1 鈥� 璁� Agent 鐢� Agent 搴旂敤”
 *
 * 中文与破折号、全角标点一起坏掉。实测 2026-09-21：微信机器人的回复就是这样
 * 变成乱码的（手机端收到的正是 CLI 的 stdout）；Agent 读到的 run_momoka_cli
 * 工具结果同样受影响（带中文的输出一直是乱码）。
 */
export function decodeNodeOutput(buffer: Buffer): string {
  return buffer.toString("utf8");
}