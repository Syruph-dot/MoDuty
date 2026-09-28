import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

export const LIKERT_LABELS: Record<number, string> = {
  1: "强烈反对",
  2: "反对",
  3: "不太赞同",
  4: "中立",
  5: "有点赞同",
  6: "赞同",
  7: "强烈赞同",
};

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFile), "..");

export function resolveProjectRoot(projectRoot?: string): string {
  return path.resolve(projectRoot ?? process.env.MOMOKA_ROOT ?? packageRoot);
}

export function defaultPaths(projectRoot: string) {
  const dataRoot = resolveDataRoot(projectRoot);
  return {
    projectRoot,
    promptsDir: resolvePromptsDir(projectRoot),
    skillsDirs: resolveSkillsDirs(projectRoot),
    memoryDir: path.join(projectRoot, "memory"), // 兼容：旧位置仍用于迁移读取
    dataDir: dataRoot,
    workspacesDir: resolveWorkspacesRoot(dataRoot),
    staticDir: resolveStaticDir(projectRoot),
    logsDir: resolveLogsDir(dataRoot),
  };
}

/**
 * 解析运行时数据根目录。优先级：
 * 1) MOMOKA_DATA_DIR 环境变量
 * 2) MOMOKA_DATA_ROOT 环境变量（别名，兼容性）
 * 3) %USERPROFILE%/.momoka/data (Windows) / ~/.momoka/data (Unix)
 * 4) 兼容旧位置 projectRoot/memory
 */
export function resolveDataRoot(projectRoot: string): string {
  if (process.env.MOMOKA_DATA_DIR) {
    return path.resolve(process.env.MOMOKA_DATA_DIR);
  }
  if (process.env.MOMOKA_DATA_ROOT) {
    return path.resolve(process.env.MOMOKA_DATA_ROOT);
  }
  return path.join(os.homedir(), ".momoka", "data");
}

/**
 * 解析工作区根目录。优先级：
 * 1) MOMOKA_WORKSPACES 环境变量
 * 2) dataRoot/workspaces
 */
export function resolveWorkspacesRoot(dataRoot: string): string {
  if (process.env.MOMOKA_WORKSPACES) {
    return path.resolve(process.env.MOMOKA_WORKSPACES);
  }
  return path.join(dataRoot, "workspaces");
}

/**
 * 解析提示词目录。优先级：
 * 1) MOMOKA_PROMPTS_DIR 环境变量
 * 2) projectRoot/prompts
 */
export function resolvePromptsDir(projectRoot: string): string {
  if (process.env.MOMOKA_PROMPTS_DIR) {
    return path.resolve(process.env.MOMOKA_PROMPTS_DIR);
  }
  return path.join(projectRoot, "prompts");
}

/**
 * 解析技能目录。优先级：
 * 1) MOMOKA_SKILLS_DIR 环境变量
 * 2) projectRoot/skills
 */
/**
 * 技能来源目录（按优先级）：MOMOKA_SKILLS_DIR（若设置）→ 用户级 ~/.momoka/skills → <projectRoot>/skills。
 * 用户 2026-09-28 拍板：两者取并集，同名技能以靠前的目录为准。
 */
export function resolveSkillsDirs(projectRoot: string): string[] {
  const dirs: string[] = [];
  if (process.env.MOMOKA_SKILLS_DIR) {
    dirs.push(path.resolve(process.env.MOMOKA_SKILLS_DIR));
  }
  dirs.push(path.join(os.homedir(), ".momoka", "skills"));
  dirs.push(path.join(projectRoot, "skills"));
  return [...new Set(dirs)];
}

/**
 * 解析静态资源目录。优先级：
 * 1) MOMOKA_STATIC_DIR 环境变量
 * 2) projectRoot/static
 */
export function resolveStaticDir(projectRoot: string): string {
  if (process.env.MOMOKA_STATIC_DIR) {
    return path.resolve(process.env.MOMOKA_STATIC_DIR);
  }
  return path.join(projectRoot, "static");
}

/**
 * 解析日志目录。优先级：
 * 1) MOMOKA_LOGS_DIR 环境变量
 * 2) dataRoot/logs
 */
export function resolveLogsDir(dataRoot: string): string {
  if (process.env.MOMOKA_LOGS_DIR) {
    return path.resolve(process.env.MOMOKA_LOGS_DIR);
  }
  return path.join(dataRoot, "logs");
}

export async function loadLocalEnv(projectRoot: string = resolveProjectRoot()): Promise<boolean> {
  const envPath = path.join(projectRoot, ".env");
  let text = "";
  try {
    text = await readFile(envPath, "utf8");
  } catch {
    return false;
  }

  applyEnvText(text);

  return true;
}

export function loadLocalEnvSync(projectRoot: string = resolveProjectRoot()): boolean {
  try {
    applyEnvText(readFileSync(path.join(projectRoot, ".env"), "utf8"));
    return true;
  } catch {
    return false;
  }
}

function applyEnvText(text: string): void {
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
