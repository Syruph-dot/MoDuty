import type { StoredToolCall } from "../serialization.js";
import type { ExternalSessionSource } from "../session-source.js";

export type {
  ExternalSessionSource,
  SessionSource,
  SourceRef,
} from "../session-source.js";
export {
  EXTERNAL_SOURCES,
  MODUTY_SOURCE,
  SOURCE_LABELS,
  isExternalSessionSource,
  isSessionSource,
  sourceOf,
} from "../session-source.js";

/**
 * 来源内一条会话的**轻量元信息**。
 *
 * 刻意不包含正文：codex 会话目录实测 1.1 GB、proma 471 MB，
 * 列表阶段只允许读索引或文件头部，正文留给 read() 按需解析。
 */
export interface SourceSessionSummary {
  /** 源内稳定 id（claude/proma 为 sessionId，codex 为 rollout 文件名里的 UUID） */
  externalId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** 消息条数；未做正文解析时为 null（列表阶段不为了计数去读整个文件） */
  messageCount: number | null;
  /** 源内的项目/工作区标识（claude 为编码后的项目目录名，codex 为 cwd，proma 为 workspaceId） */
  workspace?: string;
  archived?: boolean;
  /** 内容指纹（size-mtime），用于同步时短路「未变化」 */
  fingerprint: string;
  /** 源文件绝对路径 */
  path: string;
}

/** 与 StoredMessage 同构的导入中间态 */
export interface ImportedMessage {
  role: "user" | "agent" | "tool" | "system";
  content: string;
  timestamp: string;
  toolCalls?: StoredToolCall[];
  reasoning?: string;
  model?: string;
}

export interface SourceProbe {
  available: boolean;
  /** 来源数据根目录 */
  root: string;
  /** 不可用原因（目录不存在 / 无读取权限 / 索引为空） */
  reason?: string;
}

export interface SourceReadResult {
  summary: SourceSessionSummary;
  messages: ImportedMessage[];
}

/** 外部来源适配器：探测 → 轻量列表 → 按需解析正文 */
export interface SourceAdapter {
  readonly source: ExternalSessionSource;
  readonly label: string;
  probe(): Promise<SourceProbe>;
  list(): Promise<SourceSessionSummary[]>;
  read(externalId: string): Promise<SourceReadResult>;
}
