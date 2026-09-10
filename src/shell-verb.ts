import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/**
 * Windows 资源管理器右键菜单（Shell Verb）注册状态与操作。
 *
 * 单一事实源是 scripts/register-shell-verb.ps1：本模块只负责调用它并读取注册表结果，
 * 不重复实现注册逻辑（避免与 .reg 文件、PS 脚本三处漂移）。
 *
 * 防腐边界：Node 没有注册表 API，因此通过 PowerShell 查询并输出 JSON，本模块只解析 JSON。
 */

export const SHELL_VERB_NAME = "MoDuty.SendToDispatcher";
export const SHELL_VERB_DISPLAY = "Send to MoDuty Dispatcher";

export type ShellVerbAction = "register" | "unregister";

export interface ShellVerbKeyStatus {
  registered: boolean;
  command: string | null;
}

export interface ShellVerbStatus {
  supported: boolean;
  registered: boolean;
  partial: boolean;
  keys: {
    file: ShellVerbKeyStatus;
    directory: ShellVerbKeyStatus;
    background: ShellVerbKeyStatus;
  };
  script_exists: boolean;
  launcher_exists: boolean;
  bridge_exists: boolean;
  detail?: string;
}

interface PowerShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

function scriptPath(projectRoot: string, file: string): string {
  return path.join(projectRoot, "scripts", file);
}

function emptyKeys(): ShellVerbStatus["keys"] {
  return {
    file: { registered: false, command: null },
    directory: { registered: false, command: null },
    background: { registered: false, command: null },
  };
}

function unsupportedStatus(): ShellVerbStatus {
  return {
    supported: false,
    registered: false,
    partial: false,
    keys: emptyKeys(),
    script_exists: false,
    launcher_exists: false,
    bridge_exists: false,
  };
}

/** 以隐藏窗口执行 PowerShell 内联脚本（-EncodedCommand，UTF-16LE Base64）。 */
function runPowerShellScript(script: string): Promise<PowerShellResult> {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      resolve({ code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/** 执行 register-shell-verb.ps1 的 -Register / -Unregister。 */
function runRegisterScript(scriptFile: string, action: ShellVerbAction): Promise<PowerShellResult> {
  const flag = action === "register" ? "-Register" : "-Unregister";
  return new Promise((resolve) => {
    const child = spawn(
      "powershell",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", scriptFile, flag],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.on("error", (error) =>
      resolve({ code: -1, stdout: "", stderr: error instanceof Error ? error.message : String(error) }),
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const QUERY_SCRIPT = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$verb = "${SHELL_VERB_NAME}"
$roots = [ordered]@{
  file       = "HKCU:\\Software\\Classes\\*\\shell\\$verb"
  directory  = "HKCU:\\Software\\Classes\\Directory\\shell\\$verb"
  background = "HKCU:\\Software\\Classes\\Directory\\Background\\shell\\$verb"
}
$out = [ordered]@{}
foreach ($name in $roots.Keys) {
  $key = $roots[$name]
  $cmdKey = "$key\\command"
  $registered = Test-Path -LiteralPath $key
  $command = $null
  if (Test-Path -LiteralPath $cmdKey) {
    $command = (Get-ItemProperty -LiteralPath $cmdKey).'(default)'
  }
  $out[$name] = [ordered]@{ registered = $registered; command = $command }
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

/** 读取当前右键菜单注册状态（非 Windows 直接返回 supported:false）。 */
export async function getShellVerbStatus(projectRoot: string): Promise<ShellVerbStatus> {
  if (process.platform !== "win32") {
    return unsupportedStatus();
  }

  const status: ShellVerbStatus = {
    supported: true,
    registered: false,
    partial: false,
    keys: emptyKeys(),
    script_exists: fs.existsSync(scriptPath(projectRoot, "register-shell-verb.ps1")),
    launcher_exists: fs.existsSync(scriptPath(projectRoot, "moduty-launch.vbs")),
    bridge_exists: fs.existsSync(scriptPath(projectRoot, "shell-verb-bridge.mjs")),
  };

  const result = await runPowerShellScript(QUERY_SCRIPT);
  if (result.code !== 0) {
    status.detail = (result.stderr || result.stdout).trim().slice(0, 500);
    return status;
  }

  try {
    const parsed = JSON.parse(result.stdout.trim()) as Record<
      string,
      { registered?: boolean; command?: string | null }
    >;
    for (const name of ["file", "directory", "background"] as const) {
      const entry = parsed?.[name];
      status.keys[name] = {
        registered: Boolean(entry?.registered),
        command: typeof entry?.command === "string" ? entry.command : null,
      };
    }
  } catch (error) {
    status.detail = `无法解析注册表查询结果：${error instanceof Error ? error.message : String(error)}`;
    return status;
  }

  const flags = [status.keys.file.registered, status.keys.directory.registered, status.keys.background.registered];
  const registeredCount = flags.filter(Boolean).length;
  status.registered = registeredCount === flags.length;
  status.partial = registeredCount > 0 && !status.registered;
  return status;
}

/** 注册/注销右键菜单，返回操作后的最新状态。 */
export async function applyShellVerbAction(
  projectRoot: string,
  action: ShellVerbAction,
): Promise<ShellVerbStatus> {
  if (process.platform !== "win32") {
    return unsupportedStatus();
  }

  const scriptFile = scriptPath(projectRoot, "register-shell-verb.ps1");
  if (!fs.existsSync(scriptFile)) {
    const status = await getShellVerbStatus(projectRoot);
    status.detail = `找不到注册脚本：${scriptFile}`;
    return status;
  }

  const result = await runRegisterScript(scriptFile, action);
  const status = await getShellVerbStatus(projectRoot);
  const log = (result.stdout + "\n" + result.stderr).trim();
  if (result.code !== 0) {
    status.detail = log || `注册脚本退出码 ${result.code}`;
  } else if (log) {
    status.detail = log.slice(-1000);
  }
  return status;
}
