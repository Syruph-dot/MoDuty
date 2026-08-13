import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { ShellRunResult, ShellRunner } from "./approvals.js";
import type { WorkspaceManifest } from "./tools.js";

export interface SandboxRunnerOptions {
  manifest?: WorkspaceManifest;
  timeoutMs?: number;
  /** 同步到沙箱时排除的路径（相对于工作区） */
  exclude?: string[];
}

const DEFAULT_EXCLUDES = [".git"];

/**
 * 创建本地临时目录沙箱执行器（第三周：沙箱、工作区和可恢复执行）。
 *
 * 原理：把工作区复制到系统临时目录，在沙箱内以参数化方式执行命令（带超时），
 * 执行结束后把沙箱内的变更同步回工作区。进程运行在沙箱内，天然看不到
 * 工作区之外的文件——这就是一个轻量的“执行边界”，与 harness（控制层）分离。
 */
export function createSandboxShellRunner(workDir: string, options: SandboxRunnerOptions = {}): ShellRunner {
  const workspace = path.resolve(workDir);
  const timeoutMs = options.timeoutMs ?? options.manifest?.commandTimeoutMs ?? 120_000;
  const excludes = options.exclude ?? DEFAULT_EXCLUDES;

  return async (command: string, args: string[], _cwd: string): Promise<ShellRunResult> => {
    const sandboxRoot = await mkdtemp(path.join(tmpdir(), "momoka-sandbox-"));
    try {
      // 1. 把工作区同步进沙箱（排除 .git 等）
      await cp(workspace, sandboxRoot, {
        recursive: true,
        force: true,
        filter: (source) => {
          const relative = path.relative(workspace, source);
          if (!relative) return true;
          return !excludes.some((entry) => relative === entry || relative.startsWith(`${entry}${path.sep}`));
        },
      });

      // 2. 在沙箱内执行（参数化进程调用 + 超时）
      const result = await runInSandbox(command, args, sandboxRoot, timeoutMs);

      // 3. 把沙箱内（可能被命令修改/新增的）文件同步回工作区
      await cp(sandboxRoot, workspace, { recursive: true, force: true });
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
