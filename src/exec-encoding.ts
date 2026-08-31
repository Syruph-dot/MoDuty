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