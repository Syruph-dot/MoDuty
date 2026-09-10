#!/usr/bin/env node
/**
 * MoDuty Shell Verb Bridge — 右键菜单桥接程序
 *
 * 用法：右键菜单注册时关联 moduty-launch.vbs，由其隐藏启动本脚本
 * 调用方式：node shell-verb-bridge.mjs <file1> [file2] ...
 *
 * 流程（一次右键选择 = 一个输入框 = 一条消息）：
 * 1. 上报信标 POST /beacon —— Explorer 对静态动词是「每个选中项调一次命令」，
 *    所以选 N 个文件会起 N 个本进程；daemon 把这些调用聚成一批。
 * 2. 非 leader 进程上报后直接退出；leader 长挂 GET /beacon-collect 等 daemon 收齐。
 * 3. leader 弹出唯一一个输入框，列出本批全部路径。
 * 4. 调用 daemon /find-dispatcher 拿值日生 ID，再 POST /dispatch-files 发一条消息。
 * 5. 结果显示为系统消息框。
 *
 * Windows 实现要点：
 * - PowerShell 一律用 -EncodedCommand（UTF-16LE Base64）传脚本：
 *   多行脚本 + shell:true 会被 cmd.exe 按换行拆断，导致 -Command 缺参数、弹窗永不出现。
 * - 【不要】给 spawn 加 windowsHide:true：Node 把它映射为 libuv UV_PROCESS_WINDOWS_HIDE，
 *   会同时隐藏控制台和 GUI 窗口，导致 WinForms 输入框/消息框永远不显示（进程活着但无窗口）。
 *   正确做法是让 PowerShell 自己带 -WindowStyle Hidden：只隐藏控制台，GUI 照常显示。
 * - 提示文本经环境变量传入，结果经 UTF-8 文件回传，避免命令行转义与控制台代码页问题。
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const DAEMON_PORT =
  process.env.MODUTY_DAEMON_PORT ?? process.env.DAEMON_PORT ?? "8889";
const DAEMON_HOST = "127.0.0.1";

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));

function httpRequest(method, reqPath, body = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: DAEMON_HOST,
      port: DAEMON_PORT,
      path: reqPath,
      method,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: timeoutMs,
    };
    if (body) {
      options.headers["Content-Length"] = Buffer.byteLength(body);
    }

    const req = http.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode, data: data ? JSON.parse(data) : {} });
        } catch {
          resolve({ status: res.statusCode, data: data });
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("请求超时"));
    });
    if (body) req.write(body);
    req.end();
  });
}

/** 连不上 daemon 时给出可读提示，其余错误原样返回 */
function friendlyDaemonError(err) {
  const raw = err?.message ?? String(err);
  return /ECONNREFUSED|socket hang up|EADDRNOTAVAIL/.test(raw)
    ? `无法连接 MoDuty Daemon（127.0.0.1:${DAEMON_PORT}）。请先启动后台服务后重试。`
    : raw;
}

/**
 * 以隐藏控制台的方式执行一段 PowerShell。
 * @param {string} psScript PowerShell 脚本文本
 * @param {Record<string, string>} extraEnv 追加环境变量（用于传参，避免命令行转义）
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runPowerShell(psScript, extraEnv = {}) {
  const encoded = Buffer.from(psScript, "utf16le").toString("base64");
  const psArgs = [
    "-NoProfile",
    "-NonInteractive",
    "-WindowStyle",
    "Hidden",
    "-ExecutionPolicy",
    "Bypass",
    "-EncodedCommand",
    encoded,
  ];

  return new Promise((resolve) => {
    const child = spawn("powershell", psArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...extraEnv },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
    child.stderr.on("data", (d) => (stderr += d.toString("utf8")));
    child.on("error", (err) =>
      resolve({ code: -1, stdout: "", stderr: String(err?.message ?? err) })
    );
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

const INPUT_DIALOG_PS = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "MoDuty - 发送给值日生"
$form.ClientSize = New-Object System.Drawing.Size(520, 250)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = $env:MODUTY_PROMPT
$label.Location = New-Object System.Drawing.Point(20, 15)
$label.Size = New-Object System.Drawing.Size(480, 70)
$label.AutoSize = $false
$form.Controls.Add($label)

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Multiline = $true
$textBox.Location = New-Object System.Drawing.Point(20, 90)
$textBox.Size = New-Object System.Drawing.Size(480, 100)
$textBox.ScrollBars = "Vertical"
$textBox.AcceptsReturn = $true
$form.Controls.Add($textBox)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = "发送"
$btnOk.Location = New-Object System.Drawing.Point(340, 200)
$btnOk.Size = New-Object System.Drawing.Size(75, 30)
$btnOk.DialogResult = [System.Windows.Forms.DialogResult]::OK
$form.Controls.Add($btnOk)
$form.AcceptButton = $btnOk

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = "取消"
$btnCancel.Location = New-Object System.Drawing.Point(425, 200)
$btnCancel.Size = New-Object System.Drawing.Size(75, 30)
$btnCancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$form.Controls.Add($btnCancel)
$form.CancelButton = $btnCancel

$form.Add_Shown({ $form.Activate(); $textBox.Focus() })

$result = $form.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
    [System.IO.File]::WriteAllText($env:MODUTY_OUT, $textBox.Text, (New-Object System.Text.UTF8Encoding($false)))
    exit 0
} else {
    exit 2
}
`;

/**
 * 弹出输入窗，返回用户输入的指令。
 * @returns {Promise<string|null>} null 表示用户取消
 */
async function showInputDialog(prompt) {
  const outFile = path.join(
    os.tmpdir(),
    `moduty-input-${process.pid}-${Date.now()}.txt`
  );

  try {
    const { code, stderr } = await runPowerShell(INPUT_DIALOG_PS, {
      MODUTY_PROMPT: prompt,
      MODUTY_OUT: outFile,
    });

    if (code === 0) {
      const text = fs.readFileSync(outFile, "utf8").trim();
      return text;
    }
    if (code === 2) {
      return null;
    }
    throw new Error(`输入窗口异常（exit ${code}）：${stderr.trim().slice(0, 300)}`);
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

const MESSAGE_BOX_PS = `
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show(
  $env:MODUTY_MSG,
  $env:MODUTY_TITLE,
  [System.Windows.Forms.MessageBoxButtons]::OK,
  [System.Windows.Forms.MessageBoxIcon]::$env:MODUTY_ICON
) | Out-Null
`;

/**
 * 弹出系统消息框（默认阻塞到用户关闭）。
 * 用 MessageBox 而不是托盘气泡：气泡会被专注助手/通知设置静默吞掉。
 */
async function showMessageBox(title, message, icon = "Warning") {
  await runPowerShell(MESSAGE_BOX_PS, {
    MODUTY_TITLE: title,
    MODUTY_MSG: message,
    MODUTY_ICON: icon,
  });
}

async function main() {
  console.log(`[bridge] 本次调用收到 ${files.length} 个路径:`, files.join(", "));

  if (files.length === 0) {
    await showMessageBox(
      "MoDuty",
      "没有收到文件路径。请通过右键菜单选择一个文件或文件夹后再试。"
    );
    process.exit(1);
  }

  // 1. 上报信标，交给 daemon 把「一次选择触发的 N 次调用」聚成一批
  let batchId = null;
  let isLeader = false;
  try {
    for (const filePath of files) {
      const beaconRes = await httpRequest("POST", "/beacon", JSON.stringify({ path: filePath }));
      if (beaconRes.status !== 200) {
        throw new Error(`/beacon HTTP ${beaconRes.status}: ${JSON.stringify(beaconRes.data)}`);
      }
      if (typeof beaconRes.data?.batchId === "string") batchId = beaconRes.data.batchId;
      if (beaconRes.data?.leader === true) isLeader = true;
    }
  } catch (err) {
    console.error("[bridge] 信标上报失败:", err?.message ?? err);
    await showMessageBox("MoDuty 错误", friendlyDaemonError(err));
    process.exit(1);
  }

  if (!isLeader) {
    console.log(`[bridge] 非 leader（batch ${batchId}），上报路径后退出`);
    return;
  }

  // 2. leader 长挂等 daemon 收齐（静默 / 文件数上限 / 最长等待）
  let paths = [];
  try {
    const collected = await httpRequest(
      "GET",
      `/beacon-collect?batchId=${encodeURIComponent(batchId ?? "")}`,
      null,
      15000
    );
    if (collected.status === 200 && Array.isArray(collected.data?.paths)) {
      paths = collected.data.paths.filter((p) => typeof p === "string" && p);
    } else {
      console.warn(`[bridge] collect 未返回路径（HTTP ${collected.status}）`);
    }
  } catch (err) {
    console.error("[bridge] collect 失败:", err?.message ?? err);
  }
  if (paths.length === 0) paths = files;
  console.log(`[bridge] 本批共 ${paths.length} 个路径:`, paths.join(", "));

  // 3. 弹唯一一个输入窗（列出本批全部路径）
  const fileList = paths.map((f, i) => `${i + 1}. ${f}`).join("\n");
  const prompt = `已选 ${paths.length} 个文件/文件夹：\n${fileList}\n\n请输入处理指令（如：转换为 wav 格式、提取文本内容、批量重命名等）：`;

  let message;
  try {
    message = await showInputDialog(prompt);
  } catch (err) {
    console.error("[bridge] 输入窗口失败:", err.message);
    await showMessageBox("MoDuty 输入窗口失败", err.message);
    process.exit(1);
  }

  if (message === null) {
    console.log("[bridge] 用户取消");
    return;
  }
  if (!message) {
    await showMessageBox("MoDuty", "指令为空，已取消本次分发。");
    return;
  }
  console.log("[bridge] 用户指令:", message);

  try {
    // 4. 查找值日生 Agent
    console.log("[bridge] 查找值日生 Agent...");
    const findRes = await httpRequest("GET", "/find-dispatcher");
    if (findRes.status !== 200 || !findRes.data?.agentId) {
      throw new Error(
        "未找到值日生 Agent。请先启动 MoDuty Daemon，并在磁贴墙中创建值日生。"
      );
    }
    const agentId = findRes.data.agentId;
    console.log("[bridge] 值日生 Agent ID:", agentId);

    // 5. 一条消息派发（files 为本批全部路径）
    console.log("[bridge] 分发任务给值日生...");
    const dispatchRes = await httpRequest(
      "POST",
      "/dispatch-files",
      JSON.stringify({ agentId, files: paths, message })
    );

    if (
      dispatchRes.status >= 200 &&
      dispatchRes.status < 300 &&
      dispatchRes.data?.success
    ) {
      const summary = message.length > 50 ? `${message.slice(0, 50)}...` : message;
      await showMessageBox(
        "MoDuty",
        `已把 ${paths.length} 个文件合成一条消息发给值日生\n指令: ${summary}`,
        "Information"
      );
      console.log("[bridge] 分发成功:", dispatchRes.data);
    } else {
      const errMsg = dispatchRes.data?.error ?? `HTTP ${dispatchRes.status}`;
      throw new Error(`分发失败: ${errMsg}`);
    }
  } catch (err) {
    console.error("[bridge] 错误:", err?.message ?? err);
    await showMessageBox("MoDuty 错误", friendlyDaemonError(err));
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error("[bridge] 未捕获错误:", err);
  try {
    await showMessageBox("MoDuty 错误", String(err?.message ?? err));
  } catch {
    // 消息框本身失败时不再递归处理
  }
  process.exit(1);
});
