import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";

import { atomicWrite, withFileLock } from "./write-queue.js";

/**
 * 软件内模型配置的持久化层（v2：模型配置池）。
 *
 * 文件位置：用户 home 下的 `.momoka/settings.json`
 *   - Windows: C:\Users\<user>\.momoka\settings.json
 *   - macOS/Linux: ~/.momoka/settings.json
 *
 * v1（{ apiKey, baseUrl, model } 单组）在首次读取时自动迁移成一条池条目
 * （id=legacy），并作为 high 默认；保存时落盘为 v2，不再保留 v1 顶层字段。
 *
 * 模型池 = 模型条目集合；每条目绑定 baseUrl + apiKey + model（模型名），
 * 支持独立启用/停用。high / low / exact 只是指向池条目的“指针”，
 * 仅在选择模型层生效，不涉及其它系统。
 */
export interface ModelPoolEntry {
  /** 唯一 id */
  id: string;
  /** 显示名（如 “OpenCode Zen 日常”） */
  name: string;
  /** OpenAI 兼容 Base URL */
  baseUrl: string;
  /** API Key（可选；部分服务免鉴权） */
  apiKey?: string;
  /** 该条目使用的模型名 */
  model: string;
  /** 上下文窗口（tokens）；未设置时按模型名自动推断 */
  contextWindow?: number;
  /**
   * 该条目对应模型是否支持图片输入（多模态）。
   * 未标记 = 不支持：附件里的图片不会被直接发给它，只在清单里留路径与占位说明。
   * 保守默认是有意的——上游对不支持的模型收到 image_url 会直接报错。
   */
  supportsVision?: boolean;
  /** 是否启用（停用条目不可被 high/low/exact 解析使用） */
  enabled: boolean;
}

export interface TierDefaults {
  /** high 默认条目 id */
  high: string | null;
  /** low 默认条目 id */
  low: string | null;
  /** exact（手动指定模型）默认条目 id */
  exact: string | null;
}

/** v2 设置形态 */
export interface MomokaSettings {
  modelPool: ModelPoolEntry[];
  tierDefaults: TierDefaults;
  /** 全局默认 Agent 人格（role 未自定义时的“我是谁/怎么干活”描述）；未设置用内置默认 */
  agentPersona?: string;
  /** Explicit opt-in to recall work experiences from other workspaces. */
  crossWorkspaceExperienceRecall?: boolean;
}

/** v1 遗留信息（仅当用户还没保存过 v2 时通过迁移合成，供诊断展示） */
export interface MomokaLegacyInfo {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export const LEGACY_ENTRY_ID = "legacy";

const SETTINGS_DIR = path.join(os.homedir(), ".momoka");
const SETTINGS_PATH = path.join(SETTINGS_DIR, "settings.json");

interface RawSettingsFile {
  modelPool?: unknown;
  tierDefaults?: { high?: unknown; low?: unknown; exact?: unknown };
  agentPersona?: unknown;
  crossWorkspaceExperienceRecall?: unknown;
  // v1 字段
  apiKey?: unknown;
  baseUrl?: unknown;
  model?: unknown;
}

function emptyDefaults(): TierDefaults {
  return { high: null, low: null, exact: null };
}

function normalizeEntry(raw: unknown): ModelPoolEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const baseUrl = typeof obj.baseUrl === "string" ? obj.baseUrl.trim() : "";
  const model = typeof obj.model === "string" ? obj.model.trim() : "";
  if (!baseUrl && !model) return null;
  return {
    id: typeof obj.id === "string" && obj.id.trim() ? obj.id.trim() : createModelPoolEntryId(typeof obj.name === "string" ? obj.name : "model"),
    name: typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : model || baseUrl,
    baseUrl,
    apiKey: typeof obj.apiKey === "string" ? obj.apiKey : undefined,
    model,
    ...(typeof obj.contextWindow === "number" && Number.isSafeInteger(obj.contextWindow) && obj.contextWindow > 0
      ? { contextWindow: obj.contextWindow }
      : {}),
    ...(obj.supportsVision === true ? { supportsVision: true } : {}),
    enabled: obj.enabled !== false,
  };
}

/** 由名称生成稳定的池条目 id（小写字母数字连字符） */
export function createModelPoolEntryId(name: string): string {
  const slug = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || `model-${Date.now().toString(36)}`;
}

function normalizeTierDefaults(raw: RawSettingsFile["tierDefaults"]): TierDefaults {
  const read = (value: unknown): string | null =>
    typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    high: read(raw?.high),
    low: read(raw?.low),
    exact: read(raw?.exact),
  };
}

/** 读取池中某条目；不存在或未启用返回 undefined */
export function findPoolEntry(settings: MomokaSettings, entryId: string | null | undefined): ModelPoolEntry | undefined {
  if (!entryId) return undefined;
  const entry = settings.modelPool.find((item) => item.id === entryId);
  return entry && entry.enabled ? entry : undefined;
}

async function readRaw(): Promise<RawSettingsFile | null> {
  try {
    const text = await fs.readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(text) as RawSettingsFile;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 读取当前设置。
 * - v2 文件：直接返回池与默认；
 * - v1 文件（或裸 env 时代旧文件）：迁移合成为一条 legacy 池条目并作为 high 默认（不写回，保存时才落盘 v2）。
 */
export async function loadSettings(): Promise<MomokaSettings> {
  const raw = await readRaw();
  if (!raw) {
    return { modelPool: [], tierDefaults: emptyDefaults(), crossWorkspaceExperienceRecall: false };
  }

  if (Array.isArray(raw.modelPool)) {
    const pool = raw.modelPool
      .map((item) => normalizeEntry(item))
      .filter((item): item is ModelPoolEntry => item !== null);
    return {
      modelPool: pool,
      tierDefaults: normalizeTierDefaults(raw.tierDefaults),
      crossWorkspaceExperienceRecall: raw.crossWorkspaceExperienceRecall === true,
      ...(typeof raw.agentPersona === "string" && raw.agentPersona.trim()
        ? { agentPersona: raw.agentPersona }
        : {}),
    };
  }

  // v1 迁移：单组配置 → legacy 条目
  const legacyBaseUrl = typeof raw.baseUrl === "string" ? raw.baseUrl.trim() : "";
  const legacyModel = typeof raw.model === "string" ? raw.model.trim() : "";
  const legacyApiKey = typeof raw.apiKey === "string" ? raw.apiKey : undefined;
  if (legacyBaseUrl || legacyModel || legacyApiKey) {
    return {
      modelPool: [
        {
          id: LEGACY_ENTRY_ID,
          name: "默认配置（旧版迁移）",
          baseUrl: legacyBaseUrl,
          apiKey: legacyApiKey,
          model: legacyModel,
          enabled: true,
        },
      ],
      tierDefaults: { high: LEGACY_ENTRY_ID, low: null, exact: null },
      crossWorkspaceExperienceRecall: raw.crossWorkspaceExperienceRecall === true,
      ...(typeof raw.agentPersona === "string" && raw.agentPersona.trim()
        ? { agentPersona: raw.agentPersona }
        : {}),
    };
  }

  return {
    modelPool: [],
    tierDefaults: emptyDefaults(),
    crossWorkspaceExperienceRecall: raw.crossWorkspaceExperienceRecall === true,
    ...(typeof raw.agentPersona === "string" && raw.agentPersona.trim()
      ? { agentPersona: raw.agentPersona }
      : {}),
  };
}

/** 读 v1 遗留原始字段（仅用于日志/兼容提示） */
export async function loadLegacyInfo(): Promise<MomokaLegacyInfo> {
  const raw = await readRaw();
  if (!raw || Array.isArray(raw.modelPool)) return {};
  return {
    apiKey: typeof raw.apiKey === "string" ? raw.apiKey : undefined,
    baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : undefined,
    model: typeof raw.model === "string" ? raw.model : undefined,
  };
}

/** 保存 v2：整体替换池与/或默认指针；旧 v1 顶层字段随之移除 */
export async function saveSettings(patch: {
  modelPool?: ModelPoolEntry[];
  tierDefaults?: Partial<TierDefaults>;
  agentPersona?: string | null;
  crossWorkspaceExperienceRecall?: boolean;
}): Promise<void> {
  const current = await loadSettings();
  const raw = await readRaw();

  let nextPool = current.modelPool;
  if (patch.modelPool !== undefined) {
    nextPool = patch.modelPool
      .map((item) => normalizeEntry(item))
      .filter((item): item is ModelPoolEntry => item !== null);
  }

  const nextDefaults: TierDefaults = {
    high: patch.tierDefaults?.high !== undefined ? patch.tierDefaults.high : current.tierDefaults.high,
    low: patch.tierDefaults?.low !== undefined ? patch.tierDefaults.low : current.tierDefaults.low,
    exact: patch.tierDefaults?.exact !== undefined ? patch.tierDefaults.exact : current.tierDefaults.exact,
  };
  // 默认指针若指向已删除条目则清空
  const poolIds = new Set(nextPool.map((item) => item.id));
  for (const key of ["high", "low", "exact"] as const) {
    const ref = nextDefaults[key];
    if (ref && !poolIds.has(ref)) nextDefaults[key] = null;
  }
  // 停用条目不担任默认（若被指向则回退到池中同 id 已禁用情况 —— 保留 id 但 findPoolEntry 会忽略，
  // 这里显式清空避免设置页显示歧义）
  for (const key of ["high", "low", "exact"] as const) {
    const ref = nextDefaults[key];
    if (ref) {
      const entry = nextPool.find((item) => item.id === ref);
      if (!entry || !entry.enabled) nextDefaults[key] = null;
    }
  }

  const next: MomokaSettings = {
    modelPool: nextPool,
    tierDefaults: nextDefaults,
    ...(patch.agentPersona !== undefined
      ? patch.agentPersona && patch.agentPersona.trim()
        ? { agentPersona: patch.agentPersona }
        : {}
      : current.agentPersona
        ? { agentPersona: current.agentPersona }
        : {}),
    crossWorkspaceExperienceRecall: patch.crossWorkspaceExperienceRecall ?? current.crossWorkspaceExperienceRecall ?? false,
  };
  const payload = raw && Array.isArray((raw as RawSettingsFile).modelPool)
    ? next // 已是 v2
    : { ...next }; // v1 → v2（写掉旧字段）
  await withFileLock(SETTINGS_PATH, () =>
    atomicWrite(SETTINGS_PATH, `${JSON.stringify(payload, null, 2)}\n`),
  );
}
