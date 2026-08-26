import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

/**
 * 软件内凭证/模型配置的持久化层。
 *
 * 文件位置：用户 home 下的 `.momoka/settings.json`
 *   - Windows: C:\Users\<user>\.momoka\settings.json
 *   - macOS/Linux: ~/.momoka/settings.json
 *
 * 设计要点：
 * - 不依赖任何环境变量传递，规避 Tauri sidecar 自定义 env 不可靠的问题；
 * - 改完立即由 model-client 在每次 run 时重读，无需重启后端；
 * - 用户也可直接手改该文件。
 */
export interface MomokaSettings {
  /** API Key / Token（OpenAI 兼容鉴权） */
  apiKey?: string;
  /** OpenAI 兼容 Base URL；留空=默认阿里云 DashScope */
  baseUrl?: string;
  /** 默认模型名 */
  model?: string;
}

const SETTINGS_DIR = path.join(os.homedir(), ".momoka");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

export async function loadSettings(): Promise<Partial<MomokaSettings>> {
  try {
    const text = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(text) as Partial<MomokaSettings>;
    return {
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : undefined,
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : undefined,
      model: typeof parsed.model === "string" ? parsed.model : undefined,
    };
  } catch {
    return {};
  }
}

export async function saveSettings(patch: Partial<MomokaSettings>): Promise<void> {
  let current: Partial<MomokaSettings> = {};
  try {
    const text = await fs.readFile(SETTINGS_PATH, "utf8");
    current = JSON.parse(text) as Partial<MomokaSettings>;
  } catch {
    // 文件不存在则从头创建
  }
  const next: Partial<MomokaSettings> = { ...current };
  if (typeof patch.apiKey === "string") next.apiKey = patch.apiKey;
  if (typeof patch.baseUrl === "string") next.baseUrl = patch.baseUrl;
  if (typeof patch.model === "string") next.model = patch.model;
  await fs.mkdir(SETTINGS_DIR, { recursive: true });
  await fs.writeFile(SETTINGS_PATH, JSON.stringify(next, null, 2), "utf8");
}
