import { EXTERNAL_SOURCES, type ExternalSessionSource } from "../session-source.js";
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { promaAdapter } from "./proma.js";
import type { SourceAdapter } from "./types.js";

/**
 * 外部来源适配器注册表。
 * 新增一个来源 = 加一个适配器文件 + 在这里补一行；`EXTERNAL_SOURCES` 是唯一的事实来源。
 */
const ADAPTERS: Record<ExternalSessionSource, SourceAdapter> = {
  claude: claudeAdapter,
  codex: codexAdapter,
  proma: promaAdapter,
};

export function getAdapter(source: ExternalSessionSource): SourceAdapter {
  return ADAPTERS[source];
}

export function allAdapters(): SourceAdapter[] {
  return EXTERNAL_SOURCES.map((source) => ADAPTERS[source]);
}
