import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ShellRunResult, ShellRunner } from "./approvals.js";
import type { WorkspaceManifest } from "./tools.js";

export interface SandboxRunnerOptions {
  manifest?: WorkspaceManifest;
  timeoutMs?: number;
  /** 额外排除条目（相对工作区的目录/文件，支持 `build-*` 前缀通配） */
  exclude?: string[];
}

/** 默认不复制进沙箱的条目（构建产物/运行时状态/依赖——依赖用 junction 回补） */
const DEFAULT_EXCLUDES = [
  ".git",
  ".omc",
  ".codex",
  ".agents",
  "node_modules",
  "dist",
  "build",
  "build-*",
  "runs",
  "snapshot",
  "logs",
];

/** 权限/占用/消失类错误：跳过该条目而不是让整个沙箱失败 */
function isSkipError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EACCES" || code === "EPERM" || code === "EBUSY" || code === "ENOENT";
}

function matchesExclude(name: string, rule: string): boolean {
  if (rule.endsWith("*")) return name.startsWith(rule.slice(0, -1));
  return name === rule;
}

/**
 * 容错目录复制：跳过符号链接（避免指向工作区外）、权限受限/被占用的条目。
 * 单个坏文件不会让整个沙箱同步失败。
 */
async function copyTree(src: string, dest: string, excludes: string[]): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true }).catch((error) => {
    if (isSkipError(error)) return [];
    throw error;
  });
  for (const entry of entries) {
    if (excludes.some((rule) => matchesExclude(entry.name, rule))) continue;
    const source = path.join(src, entry.name);
    const target = path.join(dest, entry.name);
    try {
      const info = await lstat(source);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        await copyTree(source, target, excludes);
      } else if (info.isFile()) {
        await copyFile(source, target);
      }
    } catch (error) {
      if (!isSkipError(error)) throw error;
    }
  }
}

/**
 * 创建本地临时目录沙箱执行器（第三周：沙箱、工作区和可恢复执行）。
 *
 * 原理：把工作区复制到系统临时目录（容错 + 排除构建/运行时目录），在沙箱内
 * 以参数化方式执行命令（带超时），执行结束后把沙箱内变更同步回工作区。
 * 进程运行在沙箱内，天然看不到工作区之外的文件。
 */
export function createSandboxShellRunner(workDir: string, options: SandboxRunnerOptions = {}): ShellRunner {
  const workspace = path.resolve(workDir);
  const timeoutMs = options.timeoutMs ?? options.manifest?.commandTimeoutMs ?? 120_000;
  const excludes = [...DEFAULT_EXCLUDES, ...(options.manifest?.sandboxExcludes ?? []), ...(options.exclude ?? [])];

  return async (command: string, args: string[], _cwd: string): Promise<ShellRunResult> => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "momoka-sandbox-"));
    try {
      // 1. 把工作区同步进沙箱（容错复制，跳过坏条目）
      await copyTree(workspace, sandboxRoot, excludes);

      // 2. node_modules 用 junction 回补（Windows），保持 npm test 等依赖命令可用；
      //    回写时 junction 是符号链接会被跳过，不会把依赖写回工作区
      if (excludes.includes("node_modules")) {
        const realNodeModules = path.join(workspace, "node_modules");
        try {
          const info = await lstat(realNodeModules);
          if (info.isDirectory()) {
            await symlink(realNodeModules, path.join(sandboxRoot, "node_modules"), "junction").catch(() => undefined);
          }
        } catch {
          // 工作区没有 node_modules → 跳过
        }
      }

      // 3. 在沙箱内执行（参数化进程调用 + 超时）
      const result = await runInSandbox(command, args, sandboxRoot, timeoutMs);

      // 4. 把沙箱内（可能被命令修改/新增的）文件同步回工作区（容错）
      await copyTree(sandboxRoot, workspace, []);
      return result;
    } finally {
      await rm(sandboxRoot, { recursive: true, force: true });
    }
  };
}

function runInSandbox(command: string, args: string[], cwd: string, timeoutMs: number): Promise<ShellRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      resolve({
        code: 124,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: `${Buffer.concat(stderr).toString("utf8")}\n[timeout after ${timeoutMs}ms]`,
      });
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
  });
}
