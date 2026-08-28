import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";

/**
 * 静态文件服务：从 projectRoot/static 提供遗留 web UI（只读视图）。
 * 目录穿越防护：解析后的路径必须仍在 staticRoot 内。
 */
export async function serveStatic(
  projectRoot: string,
  urlPathname: string,
  response: ServerResponse,
  headOnly: boolean,
): Promise<boolean> {
  const staticRoot = path.join(projectRoot, "static");
  const decoded = decodeURIComponent(urlPathname);
  const relativePath = decoded === "/" ? "index.html" : decoded.replace(/^\/+/u, "");
  const candidate = path.resolve(staticRoot, relativePath);
  const relative = path.relative(staticRoot, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return false;
  }
  const fileStats = await stat(candidate).catch(() => null);
  const filePath = fileStats?.isDirectory() ? path.join(candidate, "index.html") : candidate;
  const finalStats = await stat(filePath).catch(() => null);
  if (!finalStats?.isFile()) {
    return false;
  }
  response.writeHead(200, {
    "content-type": contentTypeFor(filePath),
    "cache-control": "no-store",
  });
  if (headOnly) {
    response.end();
  } else {
    response.end(await readFile(filePath));
  }
  return true;
}

function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}
