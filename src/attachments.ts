import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { MomokaHttpError } from "./http-error.js";
import type { ContentPart } from "./types.js";

/**
 * 会话附件：输入框粘贴 / 拖拽 / 选择的文件落到会话工作区内，随用户消息一起落盘。
 *
 * 为什么必须在会话工作区内：Agent 的 read_file 走工作区沙箱校验，附件放到工作区外
 * 就读不到，只能走跨工作区审批——体验与一致性都差。
 *
 * 目录布局（对齐工作区既有 .momoka/ 约定）：
 *   <workspace>/.momoka/attachments/<sessionId>/<attId>__<清洗后文件名>
 *   <workspace>/.momoka/attachments/<sessionId>/.cache/<sha1>.txt   （文档解析产物缓存）
 */

export const ATTACHMENT_DIR_SEGMENTS = [".momoka", "attachments"] as const;
/** 单个附件体积上限（对齐 Proma 的 100MB 口径） */
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
/** base64 上传（粘贴 / 文件选择）体积上限；更大的文件请走拖拽或路径导入 */
export const MAX_INLINE_UPLOAD_BYTES = 32 * 1024 * 1024;
/** 单条消息内联注入的图片张数上限（对齐 Proma 的 maxPerMessage） */
export const MAX_INLINE_IMAGES = 20;
/** 单张图片内联注入的体积上限（对齐 Proma 的 maxBytes） */
export const MAX_INLINE_IMAGE_BYTES = 4_718_592;
/** 单张图片内联注入的边长上限（对齐 Proma 的 resize 上限） */
export const MAX_INLINE_IMAGE_EDGE = 2000;

export type AttachmentSource = "paste" | "drop" | "picker";

/** 落盘在用户消息上的附件引用（字段名对齐 Proma 的 attachments 形状） */
export interface AttachmentRef {
  id: string;
  filename: string;
  mediaType: string;
  /** 相对会话工作区、以 / 分隔的路径（给模型看的就是它） */
  localPath: string;
  size: number;
  sha1: string;
  source: AttachmentSource;
  createdAt: string;
}

const MEDIA_TYPES: Record<string, string> = {
  // 图片
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  avif: "image/avif",
  tif: "image/tiff",
  tiff: "image/tiff",
  // 文本与代码
  txt: "text/plain",
  log: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  json: "application/json",
  jsonl: "application/json",
  yaml: "text/yaml",
  yml: "text/yaml",
  toml: "text/plain",
  ini: "text/plain",
  csv: "text/csv",
  tsv: "text/tab-separated-values",
  xml: "text/xml",
  html: "text/html",
  htm: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/typescript",
  jsx: "text/javascript",
  py: "text/x-python",
  rs: "text/x-rust",
  go: "text/x-go",
  java: "text/x-java",
  c: "text/x-c",
  h: "text/x-c",
  cpp: "text/x-c++",
  sh: "text/x-sh",
  ps1: "text/x-powershell",
  sql: "text/x-sql",
  // 文档
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // 其他
  zip: "application/zip",
  rar: "application/vnd.rar",
  "7z": "application/x-7z-compressed",
  tar: "application/x-tar",
  gz: "application/gzip",
};

/** 会话 id 直接参与路径，必须严格白名单；非法值一律拒绝 */
function requireSafeSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(sessionId)) {
    throw new MomokaHttpError(400, `非法的会话 id：${sessionId}`);
  }
  return sessionId;
}

/** 附件 id 直接参与路径，同样白名单 */
function requireSafeAttachmentId(id: string): string {
  const normalized = id.trim();
  if (!/^att_[A-Za-z0-9]{6,40}$/u.test(normalized)) {
    throw new MomokaHttpError(400, `非法的附件 id：${id}`);
  }
  return normalized;
}

export function attachmentsRoot(workspaceDir: string): string {
  return path.join(path.resolve(workspaceDir), ...ATTACHMENT_DIR_SEGMENTS);
}

export function sessionAttachmentsDir(workspaceDir: string, sessionId: string): string {
  return path.join(attachmentsRoot(workspaceDir), requireSafeSessionId(sessionId));
}

export function attachmentCacheDir(workspaceDir: string, sessionId: string): string {
  return path.join(sessionAttachmentsDir(workspaceDir, sessionId), ".cache");
}

/** 去掉路径分隔符与控制字符，限制长度；空结果回退为 file */
export function sanitizeFilename(rawName: string): string {
  const base = path.basename(String(rawName ?? "").replace(/\\/gu, "/"));
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/gu, "")
    .replace(/[<>:"|?*]/gu, "_")
    .replace(/^\.+/u, "")
    .trim();
  const safe = cleaned.length > 0 ? cleaned : "file";
  if (safe.length <= 80) return safe;
  const ext = path.extname(safe);
  const stem = safe.slice(0, Math.max(1, 80 - ext.length));
  return `${stem}${ext.slice(0, 16)}`;
}

export function guessMediaType(filename: string): string {
  const ext = path.extname(filename).toLowerCase().replace(/^\./u, "");
  return MEDIA_TYPES[ext] ?? "application/octet-stream";
}

export function isImageMediaType(mediaType: string): boolean {
  return mediaType.toLowerCase().startsWith("image/");
}

export function isTextMediaType(mediaType: string): boolean {
  const value = mediaType.toLowerCase();
  return value.startsWith("text/") || value === "application/json" || value === "application/xml";
}

export function formatBytes(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0B";
  if (size < 1024) return `${size}B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
  return `${(size / 1024 / 1024).toFixed(1)}MB`;
}

/** 取名称主干的短横线形式（仅用于展示前的兜底命名） */
export function defaultPastedFilename(mediaType: string, now = new Date()): string {
  const stamp = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("") + `-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;
  const ext = extensionForMediaType(mediaType);
  return `粘贴附件-${stamp}${ext}`;
}

function extensionForMediaType(mediaType: string): string {
  const normalized = mediaType.toLowerCase();
  for (const [ext, type] of Object.entries(MEDIA_TYPES)) {
    if (type === normalized && !["jsonl", "markdown", "htm"].includes(ext)) return `.${ext}`;
  }
  return "";
}

function sha1Of(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

function toLocalPath(workspaceDir: string, absPath: string): string {
  return path.relative(path.resolve(workspaceDir), absPath).split(path.sep).join("/");
}

/** 解析后的路径必须仍在工作区内（防目录穿越） */
export function assertInsideWorkspace(workspaceDir: string, candidate: string): string {
  const root = path.resolve(workspaceDir);
  const resolved = path.resolve(candidate);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new MomokaHttpError(400, `路径越出工作区：${candidate}`);
  }
  return resolved;
}

function mediaTypeFromInput(filename: string, declared?: string): string {
  const value = (declared ?? "").trim();
  if (value && value !== "application/octet-stream") return value;
  return guessMediaType(filename);
}

async function writeAttachmentFile(input: {
  workspaceDir: string;
  sessionId: string;
  filename: string;
  mediaType?: string;
  data: Uint8Array;
  source: AttachmentSource;
}): Promise<AttachmentRef> {
  const data = Buffer.from(input.data);
  if (data.byteLength === 0) {
    throw new MomokaHttpError(400, `附件内容为空：${input.filename}`);
  }
  if (data.byteLength > MAX_ATTACHMENT_BYTES) {
    throw new MomokaHttpError(413, `附件超过 ${formatBytes(MAX_ATTACHMENT_BYTES)} 上限：${input.filename}`);
  }
  const filename = sanitizeFilename(input.filename);
  const mediaType = mediaTypeFromInput(filename, input.mediaType);
  const sha1 = sha1Of(data);
  const id = `att_${sha1.slice(0, 12)}`;
  const dir = sessionAttachmentsDir(input.workspaceDir, input.sessionId);
  await mkdir(dir, { recursive: true });
  const absPath = path.join(dir, `${id}__${filename}`);
  await writeFile(absPath, data);
  return {
    id,
    filename,
    mediaType,
    localPath: toLocalPath(input.workspaceDir, absPath),
    size: data.byteLength,
    sha1,
    source: input.source,
    createdAt: new Date().toISOString(),
  };
}

/** 字节入口：粘贴 / 文件选择走这里（粘贴拿不到本地路径，只能给字节） */
export async function saveAttachmentBytes(input: {
  workspaceDir: string;
  sessionId: string;
  filename: string;
  mediaType?: string;
  data: Uint8Array;
  source?: AttachmentSource;
}): Promise<AttachmentRef> {
  if (input.data.byteLength > MAX_INLINE_UPLOAD_BYTES) {
    throw new MomokaHttpError(
      413,
      `该附件 ${formatBytes(input.data.byteLength)} 超过字节上传上限 ${formatBytes(MAX_INLINE_UPLOAD_BYTES)}；请改用拖拽（后端按路径直接复制）。`,
    );
  }
  return await writeAttachmentFile({ ...input, source: input.source ?? "paste" });
}

/** 路径入口：拖拽 / 外部导入走这里（原生拖放给的是绝对路径） */
export async function importAttachmentPath(input: {
  workspaceDir: string;
  sessionId: string;
  filePath: string;
  source?: AttachmentSource;
}): Promise<AttachmentRef> {
  const absSource = path.resolve(input.filePath);
  const details = await stat(absSource).catch(() => null);
  if (!details) throw new MomokaHttpError(404, `附件不存在：${absSource}`);
  if (details.isDirectory()) throw new MomokaHttpError(400, `暂不支持目录作为附件：${absSource}`);
  if (details.size > MAX_ATTACHMENT_BYTES) {
    throw new MomokaHttpError(413, `附件超过 ${formatBytes(MAX_ATTACHMENT_BYTES)} 上限：${path.basename(absSource)}`);
  }
  const filename = sanitizeFilename(path.basename(absSource));
  const mediaType = guessMediaType(filename);
  const data = await readFile(absSource);
  const sha1 = sha1Of(data);
  const id = `att_${sha1.slice(0, 12)}`;
  const dir = sessionAttachmentsDir(input.workspaceDir, input.sessionId);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, `${id}__${filename}`);
  const existed = await stat(target).catch(() => null);
  if (!existed) {
    // 复制而非移动：绝不改动用户原文件
    await copyFile(absSource, target);
  }
  return {
    id,
    filename,
    mediaType,
    localPath: toLocalPath(input.workspaceDir, target),
    size: data.byteLength,
    sha1,
    source: input.source ?? "drop",
    createdAt: new Date().toISOString(),
  };
}

function parseRefFromFilename(workspaceDir: string, sessionId: string, entry: string): AttachmentRef | null {
  const match = /^(att_[A-Za-z0-9]{6,40})__(.+)$/u.exec(entry);
  if (!match) return null;
  const id = match[1]!;
  const filename = match[2]!;
  const absPath = path.join(sessionAttachmentsDir(workspaceDir, sessionId), entry);
  return {
    id,
    filename,
    mediaType: guessMediaType(filename),
    localPath: toLocalPath(workspaceDir, absPath),
    size: 0,
    sha1: id.slice(4),
    source: "paste",
    createdAt: "",
  };
}

/** 扫描会话附件目录（.cache 除外）。落盘引用里的 size/时间以消息为准，这里只做兜底 */
export async function listAttachments(workspaceDir: string, sessionId: string): Promise<AttachmentRef[]> {
  const dir = sessionAttachmentsDir(workspaceDir, sessionId);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const refs: AttachmentRef[] = [];
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const parsed = parseRefFromFilename(workspaceDir, sessionId, entry);
    if (!parsed) continue;
    const details = await stat(path.join(dir, entry)).catch(() => null);
    if (!details?.isFile()) continue;
    refs.push({ ...parsed, size: details.size });
  }
  return refs.sort((a, b) => a.filename.localeCompare(b.filename));
}

/** 按附件 id 定位磁盘文件（同内容不同名时取第一个匹配，内容等价） */
export async function findAttachment(
  workspaceDir: string,
  sessionId: string,
  attachmentId: string,
): Promise<{ ref: AttachmentRef; absPath: string } | null> {
  const id = requireSafeAttachmentId(attachmentId);
  const dir = sessionAttachmentsDir(workspaceDir, sessionId);
  const entries = await readdir(dir).catch(() => [] as string[]);
  const entry = entries.find((item) => item.startsWith(`${id}__`));
  if (!entry) return null;
  const absPath = path.join(dir, entry);
  const details = await stat(absPath).catch(() => null);
  if (!details?.isFile()) return null;
  const filename = entry.slice(id.length + 2);
  return {
    ref: {
      id,
      filename,
      mediaType: guessMediaType(filename),
      localPath: toLocalPath(workspaceDir, absPath),
      size: details.size,
      sha1: id.slice(4),
      source: "paste",
      createdAt: details.mtime.toISOString(),
    },
    absPath,
  };
}

export async function readAttachmentBytes(
  workspaceDir: string,
  sessionId: string,
  attachmentId: string,
): Promise<{ ref: AttachmentRef; data: Buffer } | null> {
  const found = await findAttachment(workspaceDir, sessionId, attachmentId);
  if (!found) return null;
  return { ref: found.ref, data: await readFile(found.absPath) };
}

export async function deleteAttachment(workspaceDir: string, sessionId: string, attachmentId: string): Promise<boolean> {
  const found = await findAttachment(workspaceDir, sessionId, attachmentId);
  if (!found) return false;
  await unlink(found.absPath).catch(() => undefined);
  return true;
}

/* ============================================================
 * 给模型看的清单 + 内联图片
 * ============================================================ */

export interface AttachmentListingOptions {
  /** 历史轮次投影：图片数据不在本轮重复注入 */
  forHistory?: boolean;
  /** 本轮已经内联注入图片数据的附件 id */
  inlinedImageIds?: ReadonlySet<string>;
  /** 当前模型是否支持图片输入；false 时图片只留路径说明 */
  modelSupportsVision?: boolean;
}

/**
 * 附件清单（送模型的唯一文本形态）。
 *
 * 当轮 prompt 与历史投影（formatMessagesForHandoff）共用本函数，两处输出一致，
 * 上游前缀缓存才不会因为「同一轮内容两种写法」被打穿。
 */
export function formatAttachmentListing(
  refs: readonly AttachmentRef[],
  options: AttachmentListingOptions = {},
): string {
  if (refs.length === 0) return "";
  const lines = [`[附件 ${refs.length} 个]`];
  refs.forEach((ref, index) => {
    let suffix = "";
    if (isImageMediaType(ref.mediaType)) {
      if (options.forHistory) {
        suffix = "（历史轮次未重复注入图片数据；需要时用 read_file 查看）";
      } else if (options.inlinedImageIds?.has(ref.id)) {
        suffix = "（本轮已直接附上图片数据）";
      } else if (options.modelSupportsVision === false) {
        suffix = "（当前模型不支持图片输入，无法查看图像内容）";
      } else {
        suffix = "（本轮未附上图片数据；需要时用 read_file 查看）";
      }
    }
    lines.push(`${index + 1}. ${ref.filename}（${ref.mediaType}, ${formatBytes(ref.size)}）→ ${ref.localPath}${suffix}`);
  });
  lines.push("需要时用 read_file 读取上面的路径（图片会以图像形式返回，pdf/docx/xlsx 会自动提取文本）。");
  return lines.join("\n");
}

export interface InlineImageResult {
  parts: ContentPart[];
  /** 因体积/数量/格式被跳过的附件 id（清单里会标注） */
  skippedIds: string[];
}

/**
 * 把图片附件读成可直接发给模型的内容块。
 *
 * 不做缩放是不能接受的（一张 4K 截图 base64 后会把上下文撑爆），所以先用内容块通道
 * 的硬约束卡体积与张数，真正需要缩放的走 read_file（那边有图像预处理）。
 * 与 Proma 的 autoResizeImages 相比，这里的选择是「宁可少注入，也不悄悄降质」。
 */
export async function loadInlineImageParts(
  workspaceDir: string,
  sessionId: string,
  refs: readonly AttachmentRef[],
): Promise<InlineImageResult> {
  const parts: ContentPart[] = [];
  const skippedIds: string[] = [];
  let accepted = 0;
  for (const ref of refs) {
    if (!isImageMediaType(ref.mediaType)) continue;
    if (accepted >= MAX_INLINE_IMAGES) {
      skippedIds.push(ref.id);
      continue;
    }
    if (ref.size > MAX_INLINE_IMAGE_BYTES) {
      skippedIds.push(ref.id);
      continue;
    }
    const found = await findAttachment(workspaceDir, sessionId, ref.id);
    if (!found) {
      skippedIds.push(ref.id);
      continue;
    }
    const data = await readFile(found.absPath).catch(() => null);
    if (!data || data.byteLength === 0 || data.byteLength > MAX_INLINE_IMAGE_BYTES) {
      skippedIds.push(ref.id);
      continue;
    }
    parts.push({ type: "image", mimeType: found.ref.mediaType, data: data.toString("base64") });
    accepted += 1;
  }
  return { parts, skippedIds };
}

/** 供测试与调试：生成一个稳定的临时附件 id */
export function makeTemporaryAttachmentId(): string {
  return `att_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
}

/**
 * 从落盘消息里安全读回附件引用。
 *
 * 落盘数据可能来自旧版本或被手改过，这里逐字段校验而不是直接当 AttachmentRef 用：
 * 一个形状不对的 attachments 字段不应该把整轮 chat 弄崩。
 */
export function readAttachmentsFromMessage(value: unknown): AttachmentRef[] {
  if (!Array.isArray(value)) return [];
  const refs: AttachmentRef[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const filename = typeof record.filename === "string" ? record.filename : "";
    const localPath = typeof record.localPath === "string" ? record.localPath : "";
    if (!id || !localPath) continue;
    refs.push({
      id,
      filename: filename || path.posix.basename(localPath),
      mediaType: typeof record.mediaType === "string" && record.mediaType ? record.mediaType : guessMediaType(filename || localPath),
      localPath,
      size: typeof record.size === "number" && Number.isFinite(record.size) ? record.size : 0,
      sha1: typeof record.sha1 === "string" ? record.sha1 : "",
      source: record.source === "drop" || record.source === "picker" ? record.source : "paste",
      createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    });
  }
  return refs;
}
