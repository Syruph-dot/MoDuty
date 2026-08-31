# run-all.ps1 — Arona Chest / MOMOKA TS 一键启动脚本
# 职责：检查依赖 → 清理 8888/5173 端口 → 启动后端(8888) + 桌面前端(5173) → 就绪提示
# 用法：在项目根执行  ./run-all.ps1   （Ctrl+C 同时退出前后端）
# 说明：旧版 run-all.ps1 已随 commit f661983 由 npm run dev(dev-all.mjs) 取代，
#       本脚本在其基础上补齐环境检查与端口清理，再交棒给 npm run dev。

$ErrorActionPreference = "Continue"
$ProjectRoot = $PSScriptRoot
Set-Location $ProjectRoot

$Host.UI.RawUI.WindowTitle = "Arona Chest dev (8888 + 5173)"

Write-Host ""
Write-Host "=== Arona Chest / MOMOKA TS 启动 ===" -ForegroundColor Cyan
Write-Host "项目根: $ProjectRoot"

# ---- 0. 环境检查 ----
$nodeVersion = (node --version 2>$null)
if (-not $nodeVersion) {
    Write-Host "[X] 未找到 Node.js，请先安装 Node.js >= 22" -ForegroundColor Red
    exit 1
}
Write-Host "Node: $nodeVersion"
$nodeMajor = [int]($nodeVersion.TrimStart('v').Split('.')[0])
if ($nodeMajor -lt 22) {
    Write-Host "[X] 需要 Node.js >= 22，当前 $nodeVersion" -ForegroundColor Red
    exit 1
}

# ---- 1. 依赖检查（根 + desktop 各一份 package）----
foreach ($pkg in @(".", "desktop")) {
    $nm = Join-Path $ProjectRoot (Join-Path $pkg "node_modules")
    if (-not (Test-Path $nm)) {
        Write-Host "[*] $pkg 缺少 node_modules，运行 npm install ..." -ForegroundColor Yellow
        Push-Location (Join-Path $ProjectRoot $pkg)
        & npm install
        if ($LASTEXITCODE -ne 0) { Write-Host "[X] $pkg npm install 失败" -ForegroundColor Red; Pop-Location; exit 1 }
        Pop-Location
    } else {
        Write-Host "[✓] $pkg node_modules 已存在"
    }
}

# ---- 2. 清理端口（对应 server.ts 提示 "run-all.ps1 cleans port 8888"）----
foreach ($port in @(8888, 5173)) {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($conns) {
            $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
            foreach ($pid in $pids) {
                Write-Host "[*] 端口 $port 被 PID $pid 占用，结束该进程" -ForegroundColor Yellow
                Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue
            }
            Start-Sleep -Milliseconds 800
        } else {
            Write-Host "[✓] 端口 $port 空闲"
        }
    } catch {
        Write-Host "[✓] 端口 $port 空闲"
    }
}

# ---- 3. 启动 dev（dev-all.mjs：后端 8888 + 前端 5173，Ctrl+C 一并退出）----
Write-Host ""
Write-Host "启动 dev 环境 ..." -ForegroundColor Cyan
Write-Host "  后端 API: http://127.0.0.1:8888"
Write-Host "  前端 UI:  http://localhost:5173"
Write-Host "  按 Ctrl+C 退出（前后端同时停止）"
Write-Host ""
& npm.cmd run dev
$exit = $LASTEXITCODE
Write-Host "dev 已退出 (exit=$exit)" -ForegroundColor DarkGray
exit $exit