#!/usr/bin/env node
/**
 * MoDuty 存量数据迁移脚本
 * 将 projectRoot/memory/ 下的运行时数据迁移到 ~/.momoka/data/
 * 迁移完成后在旧目录写入 .legacy 标记文件，标记为只读
 *
 * 用法：
 *   node migrate-legacy-data.mjs [--project-root <path>] [--dry-run]
 *   或设置环境变量 MOMOKA_ROOT 指定项目根目录
 */

import { copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

const currentFile = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(currentFile), "..");

const LEGACY_MARKER = ".legacy";

/** 迁移项定义：type=dir 递归复制目录；type=file 复制指定文件（relPath 相对于源目录） */
const DATA_ITEMS = [
  { type: "dir", name: ".sessions" },
  { type: "file", name: ".agents", relPath: ["agents.json"] },
  { type: "file", name: ".outputs", relPath: ["outputs.json"] },
  { type: "file", name: ".annotations", relPath: ["ledger.json"] },
  { type: "file", name: ".long-term.json", relPath: [] },
  { type: "file", name: ".dispatches.json", relPath: [] },
  { type: "file", name: ".questions.json", relPath: [] },
  { type: "file", name: "relation-graph.json", relPath: [] },
];

function isTempFile(name) {
  return name.endsWith('.tmp') || name.includes('.backup-');
}

function log(msg, verbose = false) {
  if (!verbose) return;
  console.log(`  ${msg}`);
}

function info(msg) {
  console.log(`[INFO] ${msg}`);
}

function warn(msg) {
  console.warn(`[WARN] ${msg}`);
}

function error(msg) {
  console.error(`[ERROR] ${msg}`);
}

async function dirExists(dir) {
  try {
    const s = await stat(dir);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(file) {
  try {
    const s = await stat(file);
    return s.isFile();
  } catch {
    return false;
  }
}

async function copyDirRecursive(src, dest, dryRun, verbose) {
  let copied = 0;
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    if (isTempFile(entry.name)) continue;
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (!dryRun) await mkdir(destPath, { recursive: true });
      copied += await copyDirRecursive(srcPath, destPath, dryRun, verbose);
    } else {
      log(`复制文件: ${srcPath} -> ${destPath}`, verbose);
      if (!dryRun) {
        await copyFile(srcPath, destPath);
      }
      copied++;
    }
  }
  return copied;
}

async function migrateLegacyData(options) {
  const { projectRoot, dryRun, verbose } = options;
  const memoryDir = path.join(projectRoot, "memory");
  const dataRoot = path.join(os.homedir(), ".momoka", "data");

  info(`项目根目录: ${projectRoot}`);
  info(`源数据目录: ${memoryDir}`);
  info(`目标数据目录: ${dataRoot}`);
  if (dryRun) info("DRY RUN 模式 - 不会实际写入文件");

  // 检查源目录是否存在
  if (!(await dirExists(memoryDir))) {
    error(`源数据目录不存在: ${memoryDir}`);
    process.exit(1);
  }

  // 检查是否已经迁移过（存在 .legacy 标记）
  const legacyMarkerPath = path.join(memoryDir, LEGACY_MARKER);
  if (await fileExists(legacyMarkerPath)) {
    const content = await readFile(legacyMarkerPath, "utf8");
    warn(`检测到已迁移标记: ${legacyMarkerPath}`);
    info(`标记内容: ${content.trim()}`);
    info("如需强制重新迁移，请手动删除 .legacy 文件后再运行");
    return;
  }

  // 创建目标根目录
  if (!dryRun) {
    await mkdir(dataRoot, { recursive: true });
  }

  let totalCopied = 0;
  const results = [];

  for (const item of DATA_ITEMS) {
    const srcDir = path.join(memoryDir, item.name);
    const destDir = path.join(dataRoot, item.name);

    if (item.type === "dir") {
      // 目录：递归复制
      if (!(await dirExists(srcDir))) {
        results.push({ item: item.name, status: "skipped", detail: "源目录不存在" });
        log(`跳过: ${item.name} (目录不存在)`, verbose);
        continue;
      }
      try {
        const count = await copyDirRecursive(srcDir, destDir, dryRun, verbose);
        totalCopied += count;
        results.push({ item: item.name, status: "copied", detail: `${count} 个文件` });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`迁移 ${item.name} 失败: ${msg}`);
        results.push({ item: item.name, status: "error", detail: msg });
      }
    } else {
      // 文件：复制指定的 relPath 文件
      if (item.relPath.length === 0) {
        // 单文件，文件名就是 item.name
        const srcPath = path.join(memoryDir, item.name);
        const destPath = path.join(dataRoot, item.name);
        if (!(await fileExists(srcPath))) {
          results.push({ item: item.name, status: "skipped", detail: "源文件不存在" });
          log(`跳过: ${item.name} (文件不存在)`, verbose);
          continue;
        }
        try {
          if (!dryRun) await mkdir(path.dirname(destPath), { recursive: true });
          log(`复制文件: ${srcPath} -> ${destPath}`, verbose);
          if (!dryRun) await copyFile(srcPath, destPath);
          totalCopied++;
          results.push({ item: item.name, status: "copied" });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          error(`迁移 ${item.name} 失败: ${msg}`);
          results.push({ item: item.name, status: "error", detail: msg });
        }
      } else {
        // 目录下的指定文件
        let anyCopied = false;
        for (const rel of item.relPath) {
          const srcPath = path.join(srcDir, rel);
          const destPath = path.join(destDir, rel);
          if (!(await fileExists(srcPath))) {
            log(`跳过: ${item.name}/${rel} (文件不存在)`, verbose);
            continue;
          }
          try {
            if (!dryRun) await mkdir(path.dirname(destPath), { recursive: true });
            log(`复制文件: ${srcPath} -> ${destPath}`, verbose);
            if (!dryRun) await copyFile(srcPath, destPath);
            totalCopied++;
            anyCopied = true;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            error(`迁移 ${item.name}/${rel} 失败: ${msg}`);
            results.push({ item: `${item.name}/${rel}`, status: "error", detail: msg });
          }
        }
        if (anyCopied) {
          results.push({ item: item.name, status: "copied", detail: item.relPath.join(", ") });
        } else {
          results.push({ item: item.name, status: "skipped", detail: "所有指定文件均不存在" });
        }
      }
    }
  }

  // 写入 .legacy 标记文件
  if (!dryRun) {
    const markerContent = `MoDuty 存量数据已迁移
迁移时间: ${new Date().toISOString()}
源目录: ${memoryDir}
目标目录: ${dataRoot}
迁移项目: ${results.filter((r) => r.status === "copied").map((r) => r.item).join(", ")}
---
此目录已标记为只读（legacy），不再写入新数据。
新数据写入: ${dataRoot}
`;
    await writeFile(legacyMarkerPath, markerContent, "utf8");
    info(`已写入迁移标记: ${legacyMarkerPath}`);
  }

  // 汇总
  info("=== 迁移完成 ===");
  for (const r of results) {
    const icon = r.status === "copied" ? "✓" : r.status === "skipped" ? "○" : "✗";
    const detail = r.detail ? ` (${r.detail})` : "";
    console.log(`  ${icon} ${r.item}${detail}`);
  }
  info(`总计复制文件: ${totalCopied}`);
  if (dryRun) info("DRY RUN 结束 - 未实际写入，去掉 --dry-run 执行真实迁移");
}

function parseArgs() {
  const args = process.argv.slice(2);
  let projectRoot = packageRoot;
  let dryRun = false;
  let verbose = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--project-root" || arg === "-p") {
      projectRoot = path.resolve(args[++i]);
    } else if (arg === "--dry-run" || arg === "-n") {
      dryRun = true;
    } else if (arg === "--verbose" || arg === "-v") {
      verbose = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(`
用法: node migrate-legacy-data.mjs [选项]

选项:
  -p, --project-root <path>  指定项目根目录 (默认: ${packageRoot})
  -n, --dry-run              试运行，不实际写入文件
  -v, --verbose              详细输出
  -h, --help                 显示帮助

环境变量:
  MOMOKA_ROOT                项目根目录 (等同 --project-root)
`);
      process.exit(0);
    }
  }

  if (process.env.MOMOKA_ROOT) {
    projectRoot = path.resolve(process.env.MOMOKA_ROOT);
  }

  return { projectRoot, dryRun, verbose };
}

async function main() {
  console.log("MoDuty 存量数据迁移工具");
  console.log("=========================");
  try {
    const options = parseArgs();
    await migrateLegacyData(options);
  } catch (err) {
    error(`迁移失败: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

main();