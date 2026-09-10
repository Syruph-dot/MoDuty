/**
 * 右键菜单「派发文件」任务书构造。
 *
 * 一次右键选择 = 一条消息，格式（用户指定）：
 *
 *   "Apath"
 *   "Bpath"
 *   "Cpath"
 *
 *   对于以上路径，用户指示：“输入的命令”
 *
 * 独立成模块是为了让格式可被单独验证，不依赖 HTTP / 会话写入。
 */
export function buildDispatchTaskMessage(files: string[], message: string): string {
  const paths = files.map((file) => `"${file}"`).join("\n");
  const trimmed = message.trim();
  const instruction = trimmed
    ? `对于以上路径，用户指示：“${trimmed}”`
    : "对于以上路径，用户未填写指令。";
  return `${paths}\n\n${instruction}`;
}
