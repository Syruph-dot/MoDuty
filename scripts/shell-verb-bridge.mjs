#!/usr/bin/env node
/**
 * MoDuty Shell Verb Bridge — 右键菜单桥接程序
 *
 * 用法：右键菜单注册时关联此脚本作为处理程序
 * 调用方式：node shell-verb-bridge.mjs <file1> <file2> ...
 *
 * 流程：
 * 1. 接收选中的文件/文件夹路径列表
 * 2. 调用 daemon API /find-dispatcher 获取值日生 Agent ID
 * 3. 弹出输入框让用户输入指令
 * 4. 调用 daemon API /dispatch-files 分发任务
 * 5. 显示结果通知
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import http from "node:http";

const DAEMON_PORT = process.env.MODUTY_DAEMON_PORT ?? "8889";
const DAEMON_HOST = "127.0.0.1";
const DAEMON_BASE = `http://${DAEMON_HOST}:${DAEMON_PORT}`;

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith("--"));

if (files.length === 0) {
  console.error("用法: node shell-verb-bridge.mjs <file1> [file2] ...");
  process.exit(1);
}

function httpRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: DAEMON_HOST,
      port: DAEMON_PORT,
      path,
      method,
      headers: {
        "Content-Type": "application/json",
      },
      timeout: 10000,
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

async function showInputDialog(message) {
  // 使用 PowerShell 显示输入对话框
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = "MoDuty - 发送给值日生"
$form.Size = New-Object System.Drawing.Size(500, 220)
$form.StartPosition = "CenterScreen"
$form.FormBorderStyle = "FixedDialog"
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Text = "${message.replace(/"/g, '\\"')}"
$label.Location = New-Object System.Drawing.Point(20, 20)
$label.Size = New-Object System.Drawing.Size(440, 40)
$label.AutoSize = $true
$form.Controls.Add($label)

$textBox = New-Object System.Windows.Forms.TextBox
$textBox.Multiline = $true
$textBox.Location = New-Object System.Drawing.Point(20, 70)
$textBox.Size = New-Object System.Drawing.Size(440, 60)
$textBox.ScrollBars = "Vertical"
$form.Controls.Add($textBox)

$btnOk = New-Object System.Windows.Forms.Button
$btnOk.Text = "发送"
$btnOk.Location = New-Object System.Drawing.Point(320, 140)
$btnOk.Size = New-Object System.Drawing.Size(75, 30)
$btnOk.DialogResult = "OK"
$form.Controls.Add($btnOk)
$form.AcceptButton = $btnOk

$btnCancel = New-Object System.Windows.Forms.Button
$btnCancel.Text = "取消"
$btnCancel.Location = New-Object System.Drawing.Point(400, 140)
$btnCancel.Size = New-Object System.Drawing.Size(75, 30)
$btnCancel.DialogResult = "Cancel"
$form.Controls.Add($btnCancel)
$form.CancelButton = $btnCancel

$result = $form.ShowDialog()
if ($result -eq "OK") {
    $textBox.Text
} else {
    exit 1
}
`;

  return new Promise((resolve, reject) => {
    const child = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-Command", psScript], {
      shell: true,
    });
    let output = "";
    let error = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (error += d.toString()));
    child.on("close", (code) => {
      if (code === 0 && output.trim()) {
        resolve(output.trim());
      } else {
        reject(new Error("用户取消或对话框错误"));
      }
    });
  });
}

async function showNotification(title, message) {
  const psScript = `
Add-Type -AssemblyName System.Windows.Forms
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.Visible = $true
$notify.ShowBalloonTip(3000, "${title.replace(/"/g, '\\"')}", "${message.replace(/"/g, '\\"')}", "Info")
Start-Sleep -Seconds 4
$notify.Dispose()
`;
  spawn("powershell", ["-ExecutionPolicy", "Bypass", "-Command", psScript], { detached: true, stdio: "ignore" }).unref();
}

async function main() {
  console.log(`[bridge] 选中文件 (${files.length} 个):`, files.join(", "));

  try {
    // 1. 查找值日生 Agent
    console.log("[bridge] 查找值日生 Agent...");
    const findRes = await httpRequest("GET", "/find-dispatcher");
    if (findRes.status !== 200 || !findRes.data.agentId) {
      throw new Error("未找到值日生 Agent，请先在 MoDuty 中创建值日生磁贴");
    }
    const agentId = findRes.data.agentId;
    console.log("[bridge] 值日生 Agent ID:", agentId);

    // 2. 弹出输入框
    const fileList = files.map((f, i) => `${i + 1}. ${f}`).join("\n");
    const prompt = `已选 ${files.length} 个文件/文件夹：\n${fileList}\n\n请输入处理指令（如：转换为 wav 格式、提取文本内容、批量重命名等）：`;
    const message = await showInputDialog(prompt);
    console.log("[bridge] 用户指令:", message);

    // 3. 分发任务
    console.log("[bridge] 分发任务给值日生...");
    const dispatchRes = await httpRequest("POST", "/dispatch-files", JSON.stringify({
      agentId,
      files,
      message,
    }));

    if (dispatchRes.status >= 200 && dispatchRes.status < 300 && dispatchRes.data.success) {
      await showNotification("MoDuty", `已分发 ${files.length} 个文件给值日生处理\n指令: ${message.slice(0, 50)}${message.length > 50 ? "..." : ""}`);
      console.log("[bridge] 分发成功:", dispatchRes.data);
    } else {
      const errMsg = dispatchRes.data.error || "未知错误";
      await showNotification("MoDuty 分发失败", errMsg);
      throw new Error(`分发失败: ${errMsg}`);
    }
  } catch (err) {
    console.error("[bridge] 错误:", err.message);
    await showNotification("MoDuty 错误", err.message);
    process.exit(1);
  }
}

main();