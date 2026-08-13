import { mkdir, readFile, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";

/** 沙箱默认关闭：命令在宿主执行（白名单 + 审批保护），与第二周行为一致 */
const DEFAULT_SANDBOX_ENABLED = false;

let sandboxEnabled = DEFAULT_SANDBOX_ENABLED;
let settingsFilePath = "";

/** 服务启动时初始化：从 <projectRoot>/memory/sandbox-settings.json 读回上次选择 */
export function initSettings(projectRoot: string): void {
  settingsFilePath = path.join(projectRoot, "memory", "sandbox-settings.json");
  sandboxEnabled = loadSandboxEnabled();
}

export function isSandboxEnabled(): boolean {
  return sandboxEnabled;
}

/** 切换沙箱开关（立即生效 + 持久化），返回新状态 */
export async function setSandboxEnabled(enabled: boolean): Promise<boolean> {
  sandboxEnabled = Boolean(enabled);
  if (settingsFilePath) {
    await mkdir(path.dirname(settingsFilePath), { recursive: true });
    await writeFile(settingsFilePath, `${JSON.stringify({ sandboxEnabled }, null, 2)}\n`, "utf8");
  }
  return sandboxEnabled;
}

function loadSandboxEnabled(): boolean {
  if (!settingsFilePath) return DEFAULT_SANDBOX_ENABLED;
  try {
    const parsed = JSON.parse(readFileSync(settingsFilePath, "utf8")) as { sandboxEnabled?: unknown };
    return parsed.sandboxEnabled === true;
  } catch {
    return DEFAULT_SANDBOX_ENABLED;
  }
}
