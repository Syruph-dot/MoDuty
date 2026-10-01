#!/usr/bin/env node
/**
 * MoDuty Daemon — 后台常驻服务
 *
 * 功能：
 * 1. 管理 MoDuty 后端服务器生命周期（启动/停止/健康检查/自动重启）
 * 2. 提供内部 HTTP API（localhost:8889）供 Shell verb 桥进程调用
 * 3. Windows 系统托盘图标（显示状态、启动/停止/退出菜单）
 *
 * 用法：
 *   node daemon.mjs [--port <internal-port>] [--server-port <moduty-port>]
 *   环境变量：DAEMON_PORT, MODUTY_PORT, MODUTY_ROOT
 */

import { createServer, request } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.resolve(path.dirname(currentFile), "..");

const DAEMON_PORT = Number(process.env.DAEMON_PORT ?? process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] ?? 8889);
const MODUTY_PORT = Number(process.env.MODUTY_PORT ?? process.argv.find((a) => a.startsWith("--server-port="))?.split("=")[1] ?? 7238);
const MODUTY_HOST = process.env.MODUTY_HOST ?? "127.0.0.1";
const MODUTY_ROOT = process.env.MODUTY_ROOT ?? projectRoot;

/** @type {import('node:child_process').ChildProcess | null} */
let serverProcess = null;
/** @type {Object} */
let serverStatus = { running: false };
let serverStartPromise = null;

/** 启动 MoDuty 后端服务器 */
async function startServer() {
  if (serverProcess && serverStatus.running) {
    return serverStatus;
  }
  if (serverStartPromise) {
    return serverStartPromise;
  }

  serverStartPromise = (async () => {
    console.log("[daemon] 正在启动 MoDuty 后端...");
    serverStatus = { running: false, error: undefined };

    return new Promise((resolve) => {
      const child = spawn("node", ["--import", "tsx", "dev-server.mjs"], {
        cwd: MODUTY_ROOT,
        shell: false,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PORT: String(MODUTY_PORT),
          HOST: MODUTY_HOST,
        },
      });

      serverProcess = child;
      let started = false;
      const startupTimeout = setTimeout(() => {
        if (!started) {
          child.kill("SIGTERM");
          serverStatus = { running: false, error: "启动超时（30s）" };
          resolve(serverStatus);
        }
      }, 30000);

      const tag = "[moduty-server]";
      const pipe = (stream, isErr) => {
        stream.on("data", (buf) => {
          const text = buf.toString().trimEnd();
          if (!text) return;
          for (const line of text.split(/\r?\n/)) {
            console.log(`${tag}${isErr ? " ERR" : ""} ${line}`.trimEnd());
            // 检测服务器就绪标志
            if (line.includes("listening on") || line.includes("MOMOKA TypeScript HTTP Server 启动中")) {
              if (!started) {
                started = true;
                clearTimeout(startupTimeout);
                const urlMatch = line.match(/https?:\/\/[^\s]+/);
                serverStatus = {
                  running: true,
                  pid: child.pid,
                  port: MODUTY_PORT,
                  url: urlMatch ? urlMatch[0] : `http://${MODUTY_HOST}:${MODUTY_PORT}`,
                  startedAt: new Date().toISOString(),
                };
                resolve(serverStatus);
              }
            }
          }
        });
      };
      pipe(child.stdout, false);
      pipe(child.stderr, true);

      child.on("error", (err) => {
        console.error(`${tag} spawn error:`, err);
      });
    });
  })();

  try {
    return await serverStartPromise;
  } finally {
    serverStartPromise = null;
  }
}

/** 停止 MoDuty 后端服务器 */
async function stopServer() {
  if (!serverProcess) {
    serverStatus = { running: false };
    return;
  }
  console.log("[daemon] 正在停止 MoDuty 后端...");
  serverProcess.kill("SIGTERM");
  // 等待进程退出
  await new Promise((resolve) => setTimeout(resolve, 2000));
  if (serverProcess && serverProcess.exitCode === null) {
    serverProcess.kill("SIGKILL");
  }
  serverProcess = null;
  serverStatus = { running: false };
}

/** 健康检查：探测 MoDuty 后端是否可用 */
async function checkServerHealth() {
  if (!serverStatus.running || !serverProcess) {
    return { running: false };
  }
  return new Promise((resolve) => {
    const req = request(
      {
        hostname: MODUTY_HOST,
        port: MODUTY_PORT,
        path: "/health",
        method: "GET",
        timeout: 3000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            resolve({ ...serverStatus, running: true });
          } else {
            resolve({ ...serverStatus, running: false, error: `HTTP ${res.statusCode}` });
          }
        });
      },
    );
    req.on("error", () => resolve({ ...serverStatus, running: false, error: "连接失败" }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ...serverStatus, running: false, error: "超时" });
    });
    req.end();
  });
}

/** 确保服务器运行（健康检查失败则自动重启） */
async function ensureServerRunning() {
  const health = await checkServerHealth();
  if (health.running) {
    return health;
  }
  console.log("[daemon] 健康检查失败，尝试重启服务器...");
  return await startServer();
}

/** 分发文件给值日生 */
async function dispatchFiles(agentId, files, message) {
  const status = await ensureServerRunning();
  if (!status.running) {
    return { success: false, error: `MoDuty 服务不可用: ${status.error}` };
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({ files, message });
    const req = request(
      {
        hostname: MODUTY_HOST,
        port: MODUTY_PORT,
        path: `/api/agents/${encodeURIComponent(agentId)}/dispatch-files`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
        timeout: 10000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve({ success: true, result: JSON.parse(data) });
            } catch {
              resolve({ success: true, result: data });
            }
          } else {
            resolve({ success: false, error: `HTTP ${res.statusCode}: ${data}` });
          }
        });
      },
    );
    req.on("error", (err) => resolve({ success: false, error: err.message }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ success: false, error: "请求超时" });
    });
    req.write(payload);
    req.end();
  });
}

/** 查找值日生 Agent ID */
async function findDispatcherAgentId() {
  const status = await ensureServerRunning();
  if (!status.running) return null;

  return new Promise((resolve) => {
    const req = request(
      {
        hostname: MODUTY_HOST,
        port: MODUTY_PORT,
        path: "/api/agents",
        method: "GET",
        timeout: 5000,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              // API 返回 { agents: [...] }
              const agents = parsed.agents ?? [];
              const dispatcher = agents.find((a) => a.kind === "dispatcher" || a.name === "值日生");
              resolve(dispatcher?.id ?? null);
            } catch {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/* ============================================================
 * 右键菜单信标聚合（single-instance accumulator）
 *
 * 背景：Explorer 对注册表静态动词默认按「每个选中项调一次命令」，选 N 个文件
 * 会起 N 个桥进程。这里把 N 次调用聚成一批，只让第一个（leader）桥进程弹一次
 * 输入框、发一条消息。
 *
 * 时序：bridge --POST /beacon--> 建批/追加；leader --GET /beacon-collect--> 长挂，
 * 静默/到达上限/超时后返回全部路径并关闭批次；批次关闭后的信标开新批。
 * ============================================================ */

// 默认值针对「Explorer 逐个拉起桥进程」的冷启动错开：静默 600ms 才收批，
// 避免把一次多选切成两批；可用环境变量调整。
const BEACON_QUIET_MS = Number(process.env.MODUTY_BEACON_QUIET_MS ?? 600);
const BEACON_MIN_MS = Number(process.env.MODUTY_BEACON_MIN_MS ?? 600);
const BEACON_MAX_WAIT_MS = Number(process.env.MODUTY_BEACON_MAX_WAIT_MS ?? 5000);
const BEACON_MAX_FILES = Number(process.env.MODUTY_BEACON_MAX_FILES ?? 200);

/** @type {null | { id: string, paths: string[], createdAt: number, lastAt: number, closed: boolean, waiters: Set<(payload: {paths: string[], reason: string}) => void>, timer: NodeJS.Timeout | null }} */
let beaconBatch = null;

function writeJson(res, status, payload) {
  if (res.writableEnded) return;
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(payload));
}

function createBeaconBatch() {
  const batch = {
    id: `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    paths: [],
    createdAt: Date.now(),
    lastAt: Date.now(),
    closed: false,
    waiters: new Set(),
    timer: null,
  };
  batch.timer = setInterval(() => flushBeaconBatch(batch), 60);
  if (typeof batch.timer.unref === "function") batch.timer.unref();
  beaconBatch = batch;
  console.log(`[daemon] beacon batch ${batch.id} 开启`);
  return batch;
}

function closeBeaconBatch(batch, reason) {
  if (batch.closed) return;
  batch.closed = true;
  if (batch.timer) {
    clearInterval(batch.timer);
    batch.timer = null;
  }
  if (beaconBatch === batch) beaconBatch = null;
  const paths = batch.paths.slice();
  const waiters = [...batch.waiters];
  batch.waiters.clear();
  for (const waiter of waiters) waiter({ paths, reason });
  console.log(`[daemon] beacon batch ${batch.id} 关闭（${reason}）：${paths.length} 个路径`);
}

function flushBeaconBatch(batch) {
  if (batch.closed) return;
  const now = Date.now();
  if (batch.paths.length >= BEACON_MAX_FILES) {
    closeBeaconBatch(batch, "达到文件数上限");
    return;
  }
  if (now - batch.createdAt >= BEACON_MAX_WAIT_MS) {
    closeBeaconBatch(batch, "达到最长等待");
    return;
  }
  // 只有 leader 已在等（waiters 非空）时才因静默提前收批，避免抢在 leader 连接之前关批
  if (
    batch.waiters.size > 0 &&
    now - batch.createdAt >= BEACON_MIN_MS &&
    now - batch.lastAt >= BEACON_QUIET_MS
  ) {
    closeBeaconBatch(batch, "静默");
  }
}

/** 创建守护进程 HTTP 服务器（内部 API） */
function createDaemonServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${DAEMON_PORT}`);
    const pathname = url.pathname;

    // CORS for local tools
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      let body = "";
      for await (const chunk of req) body += chunk;

      switch (pathname) {
        case "/health": {
          const health = await checkServerHealth();
          res.writeHead(health.running ? 200 : 503, { "Content-Type": "application/json" });
          res.end(JSON.stringify(health));
          break;
        }
        case "/status": {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ daemon: { port: DAEMON_PORT }, server: serverStatus }));
          break;
        }
        case "/start": {
          const result = await startServer();
          res.writeHead(result.running ? 200 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          break;
        }
        case "/stop": {
          await stopServer();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ running: false }));
          break;
        }
        case "/restart": {
          await stopServer();
          const result = await startServer();
          res.writeHead(result.running ? 200 : 500, { "Content-Type": "application/json" });
          res.end(JSON.stringify(result));
          break;
        }
        case "/dispatch-files": {
          if (req.method !== "POST") {
            res.writeHead(405, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Method not allowed" }));
            break;
          }
          try {
            const { agentId, files, message } = JSON.parse(body || "{}");
            if (!agentId || !Array.isArray(files)) {
              res.writeHead(400, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "Invalid payload: need agentId, files[]" }));
              break;
            }
            const result = await dispatchFiles(agentId, files, message || "");
            res.writeHead(result.success ? 200 : 500, { "Content-Type": "application/json" });
            res.end(JSON.stringify(result));
          } catch (err) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
          }
          break;
        }
        case "/find-dispatcher": {
          const agentId = await findDispatcherAgentId();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ agentId }));
          break;
        }
        case "/beacon": {
          if (req.method !== "POST") {
            writeJson(res, 405, { error: "Method not allowed" });
            break;
          }
          let payload = {};
          try {
            payload = JSON.parse(body || "{}");
          } catch {
            payload = {};
          }
          const filePath = typeof payload.path === "string" ? payload.path.trim() : "";
          if (!filePath) {
            writeJson(res, 400, { error: "path is required" });
            break;
          }
          const batch = beaconBatch && !beaconBatch.closed ? beaconBatch : createBeaconBatch();
          const leader = batch.paths.length === 0;
          if (!batch.paths.includes(filePath)) batch.paths.push(filePath);
          batch.lastAt = Date.now();
          writeJson(res, 200, { batchId: batch.id, leader, count: batch.paths.length });
          break;
        }
        case "/beacon-collect": {
          const batchId = url.searchParams.get("batchId");
          const batch = beaconBatch;
          if (!batch || batch.closed || batch.id !== batchId) {
            writeJson(res, 409, { error: "batch 已结束", paths: [] });
            break;
          }
          let settled = false;
          const waiter = (payload) => {
            if (settled) return;
            settled = true;
            writeJson(res, 200, payload);
          };
          batch.waiters.add(waiter);
          flushBeaconBatch(batch);
          res.on("close", () => {
            if (!batch.waiters.has(waiter)) return;
            batch.waiters.delete(waiter);
            // leader 提前断开（进程被杀等）：关批，让下一次选择开新批，避免死锁
            if (batch.waiters.size === 0 && !batch.closed) closeBeaconBatch(batch, "leader 断开");
          });
          break;
        }
        default: {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Not found" }));
        }
      }
    } catch (err) {
      console.error("[daemon] 请求处理错误:", err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    }
  });

  return server;
}

/** Windows 系统托盘（使用 PowerShell 创建托盘图标） */
function setupTray() {
  if (process.platform !== "win32") {
    console.log("[daemon] 非 Windows 平台，跳过系统托盘");
    return;
  }

  // 使用 PowerShell 创建托盘图标（无需额外依赖）
  const psScript = `
$iconPath = "${path.join(MODUTY_ROOT, "static", "icon.png").replace(/\\/g, "\\\\")}"
if (-not (Test-Path $iconPath)) {
    # 创建一个简单的默认图标
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.Clear([System.Drawing.Color]::Transparent)
    $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::DodgerBlue)
    $graphics.FillEllipse($brush, 4, 4, 24, 24)
    $bmp.Save($iconPath)
    $graphics.Dispose()
    $bmp.Dispose()
}

$assembly = Add-Type -AssemblyName System.Windows.Forms
$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = [System.Drawing.Icon]::ExtractAssociatedIcon($iconPath)
$notifyIcon.Text = "MoDuty Daemon"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip

$itemStatus = New-Object System.Windows.Forms.ToolStripMenuItem "状态: 启动中..."
$itemStatus.Enabled = $false
$menu.Items.Add($itemStatus)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemStart = New-Object System.Windows.Forms.ToolStripMenuItem "启动服务"
$itemStart.Add_Click({
    try { Invoke-RestMethod -Uri "http://127.0.0.1:${DAEMON_PORT}/start" -Method POST -TimeoutSec 30 } catch {}
})
$menu.Items.Add($itemStart)

$itemStop = New-Object System.Windows.Forms.ToolStripMenuItem "停止服务"
$itemStop.Add_Click({
    try { Invoke-RestMethod -Uri "http://127.0.0.1:${DAEMON_PORT}/stop" -Method POST -TimeoutSec 10 } catch {}
})
$menu.Items.Add($itemStop)

$itemRestart = New-Object System.Windows.Forms.ToolStripMenuItem "重启服务"
$itemRestart.Add_Click({
    try { Invoke-RestMethod -Uri "http://127.0.0.1:${DAEMON_PORT}/restart" -Method POST -TimeoutSec 40 } catch {}
})
$menu.Items.Add($itemRestart)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemOpen = New-Object System.Windows.Forms.ToolStripMenuItem "打开 MoDuty 界面"
$itemOpen.Add_Click({ Start-Process "http://127.0.0.1:${MODUTY_PORT}" })
$menu.Items.Add($itemOpen)

$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))

$itemExit = New-Object System.Windows.Forms.ToolStripMenuItem "退出 Daemon"
$itemExit.Add_Click({
    try { Invoke-RestMethod -Uri "http://127.0.0.1:${DAEMON_PORT}/stop" -Method POST -TimeoutSec 10 } catch {}
    $notifyIcon.Visible = $false
    $notifyIcon.Dispose()
    Stop-Process -Id $PID
})
$menu.Items.Add($itemExit)

$notifyIcon.ContextMenuStrip = $menu

# 定时更新状态文本
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 5000
$timer.Add_Tick({
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:${DAEMON_PORT}/health" -Method GET -TimeoutSec 3
        $itemStatus.Text = "状态: " + ($h.running ? "运行中 (\${h.url})" : "已停止")
    } catch {
        $itemStatus.Text = "状态: 无法连接"
    }
})
$timer.Start()

[System.Windows.Forms.Application]::Run()
`;

  const psFile = path.join(os.tmpdir(), "moduty-daemon-tray.ps1");
  fs.writeFileSync(psFile, psScript, "utf8");

  const trayProcess = spawn("powershell", ["-ExecutionPolicy", "Bypass", "-File", psFile], {
    detached: true,
    stdio: "ignore",
  });
  trayProcess.unref();

  console.log("[daemon] 系统托盘已启动（PowerShell）");
  return trayProcess;
}

/** 主入口 */
async function main() {
  console.log("=================================");
  console.log("  MoDuty Daemon 启动中...");
  console.log("=================================");
  console.log(`  项目根目录: ${MODUTY_ROOT}`);
  console.log(`  Daemon API: http://127.0.0.1:${DAEMON_PORT}`);
  console.log(`  MoDuty 后端: http://${MODUTY_HOST}:${MODUTY_PORT}`);

  // 启动内部 API 服务器
  const daemonServer = createDaemonServer();
  await new Promise((resolve, reject) => {
    daemonServer.listen(DAEMON_PORT, "127.0.0.1", () => {
      console.log(`[daemon] 内部 API 监听: http://127.0.0.1:${DAEMON_PORT}`);
      resolve(undefined);
    });
    daemonServer.on("error", reject);
  });

  // 启动系统托盘
  setupTray();

  // 自动启动 MoDuty 后端
  console.log("[daemon] 自动启动 MoDuty 后端...");
  await startServer();

  // 保活：防止事件循环过早退出
  const keepAlive = setInterval(() => {}, 60000);
  keepAlive.unref();

  // 优雅关闭
  const shutdown = async () => {
    console.log("\n[daemon] 正在关闭...");
    clearInterval(keepAlive);
    await stopServer();
    daemonServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log("[daemon] 就绪。");
}

main().catch((err) => {
  console.error("[daemon] 致命错误:", err);
  process.exit(1);
});