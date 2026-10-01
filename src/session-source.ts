/**
 * 会话来源（Session Source）——叶子模块，刻意不依赖任何其它模块。
 *
 * `session-manager.ts`（会话记录）与 `session-sources/*`（适配器）都要用这套类型，
 * 而适配器又依赖 `serialization.ts`、后者依赖 `session-manager.ts`；
 * 把枚举与守卫放在这里可以避免三者之间形成运行时循环。
 */

/** 会话来源：moduty = 在 MoDuty 内创建；其余为外部来源的只读镜像 */
export type SessionSource = "moduty" | "claude" | "codex" | "proma";

/** 可作为导入来源的外部来源（不含 moduty 自身） */
export type ExternalSessionSource = Exclude<SessionSource, "moduty">;

export const MODUTY_SOURCE: SessionSource = "moduty";

export const EXTERNAL_SOURCES: readonly ExternalSessionSource[] = ["claude", "codex", "proma"] as const;

export const SOURCE_LABELS: Record<SessionSource, string> = {
  moduty: "MoDuty",
  claude: "Claude Code",
  codex: "Codex",
  proma: "Proma",
};

export function isSessionSource(value: unknown): value is SessionSource {
  return value === "moduty" || value === "claude" || value === "codex" || value === "proma";
}

export function isExternalSessionSource(value: unknown): value is ExternalSessionSource {
  return value === "claude" || value === "codex" || value === "proma";
}

/** 会话缺省来源：老会话没有该字段时一律视为 moduty */
export function sourceOf(record: { source?: SessionSource }): SessionSource {
  return record.source ?? MODUTY_SOURCE;
}

/** 导入镜像写回会话记录的外部来源引用（幂等与溯源的依据） */
export interface SourceRef {
  kind: ExternalSessionSource;
  externalId: string;
  /** 源文件绝对路径；来自迁移压缩包时为 `zip:<包路径>#<内部路径>` */
  sourcePath: string;
  /** 内容指纹（size-mtime）；与本地记录不一致时说明源侧已更新 */
  fingerprint: string;
  importedAt: string;
  syncedAt: string;
}
