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
    promptsDir: path.join(projectRoot, "prompts"),
    skillsDir: path.join(projectRoot, "skills"),
    memoryDir: path.join(projectRoot, "memory"),
    dataDir: dataRoot,
    staticDir: path.join(projectRoot, "static"),
    logsDir: path.join(projectRoot, "logs"),
  };
}

/**
 * 解析运行时数据根目录。优先级：
 * 1) MOMOKA_DATA_DIR 环境变量
 * 2) %USERPROFILE%/.momoka/data (Windows) / ~/.momoka/data (Unix)
 * 3) 兼容旧位置 projectRoot/memory
 */
export function resolveDataRoot(projectRoot: string): string {
  if (process.env.MOMOKA_DATA_DIR) {
    return path.resolve(process.env.MOMOKA_DATA_DIR);
  }
  return path.join(os.homedir(), ".momoka", "data");
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
