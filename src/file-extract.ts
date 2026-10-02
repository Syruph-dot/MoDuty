import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { formatBytes, guessMediaType, isImageMediaType, MAX_INLINE_IMAGE_BYTES, MAX_INLINE_IMAGE_EDGE } from "./attachments.js";
import type { ToolRunResult } from "./types.js";

/**
 * 按文件类型读取工作区文件，返回「给模型的形态」。
 *
 * 分工（对齐 Proma 的做法：磁盘文件由读文件的工具负责，图片以图像形式返回）：
 * - 图片：缩放后作为图像内容块返回（非视觉模型在 model-client 侧降级为占位文本）
 * - pdf / docx / xlsx：用解析库提取文本
 * - 其它文本：按 UTF-8 读取（与旧行为一致）
 *
 * 解析产物按内容 sha1 缓存到 <workDir>/.momoka/.cache/extract/：同一个 PDF 被反复读
 * （工具循环、后续轮次、多个 Agent）时不重复解析。
 */

export const EXTRACT_CACHE_SEGMENTS = [".momoka", ".cache", "extract"] as const;
/** 单次返回给模型的提取文本上限（超出截断并提示） */
export const MAX_EXTRACTED_CHARS = 60_000;
/** 允许读取的原始文件体积上限 */
export const MAX_READABLE_BYTES = 200 * 1024 * 1024;
/** 图片重编码质量（对齐 Proma 的 jpegQuality） */
export const IMAGE_JPEG_QUALITY = 80;
/**
 * 提取器版本。改变提取策略（换库、换格式）时递增，缓存自动失效——
 * 没有它，用户改了实现却还在读旧缓存，会以为代码没生效。
 */
const EXTRACT_VERSION = "v1";

const DOCUMENT_MEDIA_TYPES: Record<string, "pdf" | "docx" | "xlsx" | "unsupported"> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  // 旧版二进制格式没有可用的纯 JS 解析：明确告知而不是丢一堆乱码
  "application/msword": "unsupported",
  "application/vnd.ms-excel": "unsupported",
  "application/vnd.ms-powerpoint": "unsupported",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "unsupported",
};

export type DocumentKind = "pdf" | "docx" | "xlsx" | "unsupported";

export function documentKindOf(mediaType: string): DocumentKind | null {
  return DOCUMENT_MEDIA_TYPES[mediaType] ?? null;
}

function sha1Of(data: Uint8Array): string {
  return createHash("sha1").update(data).digest("hex");
}

export function truncateExtracted(text: string, limit = MAX_EXTRACTED_CHARS): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, limit)}\n…[提取文本过长已截断，共 ${text.length} 字符；需要后续内容请用 run_shell 或分段工具处理原文件]`,
    truncated: true,
  };
}

function cacheRoot(workDir?: string): string {
  return path.resolve(workDir ?? process.cwd());
}

function cachePathFor(workDir: string | undefined, kind: string, sha1: string): string {
  return path.join(cacheRoot(workDir), ...EXTRACT_CACHE_SEGMENTS, `${EXTRACT_VERSION}-${kind}-${sha1}.txt`);
}

async function readCache(workDir: string | undefined, kind: string, sha1: string): Promise<string | null> {
  const cached = await readFile(cachePathFor(workDir, kind, sha1), "utf8").catch(() => null);
  return cached && cached.trim().length > 0 ? cached : null;
}

async function writeCache(workDir: string | undefined, kind: string, sha1: string, text: string): Promise<void> {
  const target = cachePathFor(workDir, kind, sha1);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, text, "utf8").catch(() => undefined);
}

/* ============================================================
 * 图片
 * ============================================================ */

interface EncodedImage {
  mimeType: string;
  base64: string;
  bytes: number;
  width: number;
  height: number;
  resized: boolean;
  quality?: number;
}

/**
 * 图片预处理：先按最长边缩放，再按体积上限换编码/降质量。
 *
 * 为什么不能原样发：一张 4K 截图 base64 后就是几 MB，直接顶爆上下文；
 * Proma 的 autoResizeImages 也是同一思路（2000px / ~4.5MB / JPEG 80）。
 */
export async function prepareImageForModel(
  data: Buffer,
  mediaType: string,
  options: { maxEdge?: number; maxBytes?: number } = {},
): Promise<EncodedImage> {
  const maxEdge = options.maxEdge ?? MAX_INLINE_IMAGE_EDGE;
  const maxBytes = options.maxBytes ?? MAX_INLINE_IMAGE_BYTES;
  const { Jimp } = await import("jimp");
  const image = await Jimp.read(data);
  const width = image.bitmap.width;
  const height = image.bitmap.height;
  const longest = Math.max(width, height);
  let resized = false;
  if (longest > maxEdge) {
    image.scaleToFit({ w: maxEdge, h: maxEdge });
    resized = true;
  }

  const preferPng = mediaType === "image/png";
  const attempts: Array<{ mimeType: string; quality?: number; scale?: number }> = [];
  if (preferPng) {
    attempts.push({ mimeType: "image/png" });
    attempts.push({ mimeType: "image/jpeg", quality: IMAGE_JPEG_QUALITY });
  } else {
    attempts.push({ mimeType: "image/jpeg", quality: IMAGE_JPEG_QUALITY });
  }
  attempts.push({ mimeType: "image/jpeg", quality: 60 });
  attempts.push({ mimeType: "image/jpeg", quality: 70, scale: 0.6 });

  let encoded: Buffer | null = null;
  let usedMime = attempts[0]!.mimeType;
  let usedQuality: number | undefined;
  // jimp 的 getBuffer 泛型按 mime 字面量派生 options 类型，动态 mime + quality 无法静态收敛；
  // 主动收口到这一处窄类型调用（必须保留 image 作为 receiver，拆开调用会丢 this）。
  const encodeTarget = image as unknown as { getBuffer(mime: string, options?: { quality?: number }): Promise<Buffer> };
  const encode = async (mimeType: string, quality?: number): Promise<Buffer> => {
    const options = quality === undefined ? undefined : { quality };
    return Buffer.from(await encodeTarget.getBuffer(mimeType, options));
  };
  for (const attempt of attempts) {
    if (attempt.scale && attempt.scale < 1) {
      // 就地再缩一档（scaleToFit 基于当前尺寸，量级与「从原图按比例缩」一致且更省内存）
      image.scaleToFit({
        w: Math.max(320, Math.round(image.bitmap.width * attempt.scale)),
        h: Math.max(320, Math.round(image.bitmap.height * attempt.scale)),
      });
      resized = true;
    }
    encoded = await encode(attempt.mimeType, attempt.quality);
    usedMime = attempt.mimeType;
    usedQuality = attempt.quality;
    if (encoded.byteLength <= maxBytes) break;
  }
  if (!encoded) {
    throw new Error("图片编码失败");
  }
  return {
    mimeType: usedMime,
    base64: encoded.toString("base64"),
    bytes: encoded.byteLength,
    width: image.bitmap.width,
    height: image.bitmap.height,
    resized,
    ...(usedQuality ? { quality: usedQuality } : {}),
  };
}

/* ============================================================
 * 文档
 * ============================================================ */

async function extractPdf(data: Buffer): Promise<string> {
  const { extractText } = await import("unpdf");
  const result = await extractText(new Uint8Array(data), { mergePages: true });
  return `（共 ${result.totalPages} 页）\n\n${result.text}`;
}

async function extractDocx(data: Buffer): Promise<string> {
  const mammoth = await import("mammoth");
  const result = await mammoth.extractRawText({ buffer: data });
  return result.value;
}

async function extractXlsx(data: Buffer): Promise<string> {
  const { default: readXlsxFile } = await import("read-excel-file/node");
  const sheets = await readXlsxFile(data);
  return sheets
    .map((sheet) => {
      const rows = sheet.data.map((row) => row.map(formatCell).join("\t"));
      return `## 工作表：${sheet.sheet}\n${rows.join("\n")}`;
    })
    .join("\n\n");
}

/** 单元格 → 文本。Date 需要单独处理，否则会输出一整串带时区的默认格式 */
export function formatCell(cell: unknown): string {
  if (cell === null || cell === undefined) return "";
  if (cell instanceof Date) {
    // Excel 的纯时间单元格会被解析成 1899-12-30 附近的日期（1900 闰年基准）：只保留时间部分
    return cell.getFullYear() < 1901
      ? cell.toTimeString().slice(0, 8)
      : cell.toISOString().replace("T", " ").slice(0, 19);
  }
  return String(cell);
}

async function extractDocument(workDir: string | undefined, kind: Exclude<DocumentKind, "unsupported">, data: Buffer): Promise<{ text: string; cached: boolean }> {
  const sha1 = sha1Of(data);
  const cached = await readCache(workDir, kind, sha1);
  if (cached) return { text: cached, cached: true };
  const text = kind === "pdf"
    ? await extractPdf(data)
    : kind === "docx"
      ? await extractDocx(data)
      : await extractXlsx(data);
  await writeCache(workDir, kind, sha1, text);
  return { text, cached: false };
}

/* ============================================================
 * 入口
 * ============================================================ */

/**
 * 读取一个工作区文件，返回给模型的形态。
 * `displayPath` 是用户/模型视角的路径（用于结果文案），`absPath` 是已校验过的绝对路径。
 */
export async function readWorkspaceFileForModel(input: {
  workDir?: string;
  displayPath: string;
  absPath: string;
}): Promise<ToolRunResult> {
  const details = await stat(input.absPath).catch(() => null);
  if (!details) {
    return { text: `错误：文件 '${input.displayPath}' 不存在。` };
  }
  if (details.isDirectory()) {
    return { text: `错误：'${input.displayPath}' 是一个目录，请指定文件路径。` };
  }
  if (details.size > MAX_READABLE_BYTES) {
    return { text: `错误：'${input.displayPath}' 体积 ${formatBytes(details.size)} 超过单次读取上限 ${formatBytes(MAX_READABLE_BYTES)}。` };
  }

  const data = await readFile(input.absPath);
  const filename = path.basename(input.absPath);
  const mediaType = guessMediaType(filename);

  if (isImageMediaType(mediaType)) {
    if (mediaType === "image/svg+xml") {
      return { text: `'${input.displayPath}' 是 SVG 矢量图（${formatBytes(data.byteLength)}），按文本返回：\n\n${data.toString("utf8").slice(0, 20_000)}` };
    }
    try {
      const encoded = await prepareImageForModel(data, mediaType);
      const notes = [
        `Read image file '${input.displayPath}'（${mediaType} → ${encoded.mimeType}, ${encoded.width}x${encoded.height}, ${formatBytes(encoded.bytes)}${encoded.resized ? "，已缩放" : ""}${encoded.quality ? `，quality ${encoded.quality}` : ""}）`,
      ];
      return {
        text: notes.join("\n"),
        parts: [{ type: "image", mimeType: encoded.mimeType, data: encoded.base64 }],
      };
    } catch (error) {
      return { text: `图片读取失败：${error instanceof Error ? error.message : String(error)}（文件：${input.displayPath}）` };
    }
  }

  const kind = documentKindOf(mediaType);
  if (kind === "unsupported") {
    return {
      text: `'${input.displayPath}' 是 ${mediaType}（旧版 Office 二进制格式），当前没有可用的解析器。原文件在工作区，可用 run_shell 调用本机工具处理。`,
    };
  }
  if (kind) {
    try {
      const { text, cached } = await extractDocument(input.workDir, kind, data);
      const capped = truncateExtracted(text);
      return {
        text: [
          `${kind.toUpperCase()} 提取文本：'${input.displayPath}'（源 ${formatBytes(data.byteLength)}${cached ? "，命中提取缓存" : ""}${capped.truncated ? "，已截断" : ""}）`,
          "",
          capped.text,
        ].join("\n"),
      };
    } catch (error) {
      return {
        text: `${kind.toUpperCase()} 解析失败：${error instanceof Error ? error.message : String(error)}（文件：${input.displayPath}，${formatBytes(data.byteLength)}）。可尝试 run_shell 用本机工具解析。`,
      };
    }
  }

  // 其余按文本读取（与旧行为一致：非特殊类型不改变可读性）
  const capped = truncateExtracted(data.toString("utf8"));
  return { text: capped.text };
}
