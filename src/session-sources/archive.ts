import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 归档解压（Proma 迁移压缩包）。
 *
 * Proma 官方的迁移方式就是「把整个 .proma 目录压成一个 ZIP」——它没有导出 API，
 * 只有「打开数据文件夹」和「复制创建压缩包提示词」两个按钮（设置页原文）。
 * 所以 MoDuty 要吃下这个 ZIP，才能覆盖「来源数据不在本机 / Proma 没在跑」的场景。
 *
 * 刻意不引入新的 npm 依赖：优先用系统自带工具（Windows 10+ 的 bsdtar 支持 zip），
 * 失败再回落另一条通道；两条都不可用时明确报错，不静默吞掉。
 */
export interface ExtractedArchive {
  /** 解压根目录 */
  dir: string;
  /** 清理临时目录；调用方应在 finally 里执行 */
  cleanup: () => Promise<void>;
}

export async function extractArchiveToTemp(archivePath: string): Promise<ExtractedArchive> {
  const info = await stat(archivePath).catch(() => null);
  if (!info || !info.isFile()) {
    throw new Error(`压缩包不存在或不是文件：${archivePath}`);
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), "moduty-archive-"));
  const cleanup = async (): Promise<void> => {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  };

  const attempts: Array<{ name: string; run: () => Promise<void> }> = process.platform === "win32"
    ? [
        { name: "tar", run: () => run("tar", ["-xf", archivePath, "-C", dir]) },
        { name: "powershell Expand-Archive", run: () => run("powershell", ["-NoProfile", "-NonInteractive", "-Command", expandArchiveCommand(archivePath, dir)]) },
      ]
    : [
        { name: "unzip", run: () => run("unzip", ["-o", "-q", archivePath, "-d", dir]) },
        { name: "tar", run: () => run("tar", ["-xf", archivePath, "-C", dir]) },
      ];

  const errors: string[] = [];
  for (const attempt of attempts) {
    try {
      await attempt.run();
      return { dir, cleanup };
    } catch (error) {
      errors.push(`${attempt.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  await cleanup();
  throw new Error(`解压失败（已尝试 ${attempts.map((attempt) => attempt.name).join("、")}）：${errors.join("；")}`);
}

async function run(command: string, args: string[]): Promise<void> {
  await execFileAsync(command, args, { timeout: 300_000, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
}

function expandArchiveCommand(archivePath: string, dir: string): string {
  const quote = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
  return `Expand-Archive -LiteralPath ${quote(archivePath)} -DestinationPath ${quote(dir)} -Force`;
}

/**
 * 在解压结果里找 Proma 数据根（含 agent-sessions.json 的目录）。
 * 压缩包可能是 `.proma/...` 也可能直接是内容，所以做有限深度搜索。
 */
export async function findPromaRoot(dir: string, maxDepth = 4): Promise<string | null> {
  let level = [dir];
  for (let depth = 0; depth <= maxDepth && level.length; depth += 1) {
    const next: string[] = [];
    for (const candidate of level) {
      const hasIndex = await stat(path.join(candidate, "agent-sessions.json")).then(
        (info) => info.isFile(),
        () => false,
      );
      if (hasIndex) return candidate;
      const entries = await readdir(candidate, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        next.push(path.join(candidate, entry.name));
      }
    }
    level = next;
  }
  return null;
}

export interface ArchiveCandidate {
  path: string;
  name: string;
  sizeBytes: number;
  mtimeMs: number;
}

/**
 * 在常见位置找候选迁移压缩包。
 *
 * Proma 只提供「打开数据文件夹」+「复制创建压缩包提示词」两个按钮，用户得自己压 ZIP，
 * 落点通常在下载/桌面/文档。这里扫一层列出候选，避免让用户手敲绝对路径。
 */
export async function findArchiveCandidates(limit = 60): Promise<ArchiveCandidate[]> {
  const home = os.homedir();
  const roots = [path.join(home, "Downloads"), path.join(home, "Desktop"), path.join(home, "Documents"), home];
  const found: ArchiveCandidate[] = [];
  for (const root of roots) {
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".zip")) continue;
      const filePath = path.join(root, entry.name);
      const info = await stat(filePath).catch(() => null);
      if (!info?.isFile()) continue;
      found.push({ path: filePath, name: entry.name, sizeBytes: info.size, mtimeMs: info.mtimeMs });
    }
  }
  return found.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, limit);
}
