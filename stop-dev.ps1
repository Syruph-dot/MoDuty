#Requires -Version 5.1
<#
  stop-dev.ps1 - one-click kill of MoDuty dev leftovers
  Scope (safe, project-specific only):
    1) node.exe / esbuild.exe whose command line matches:
       - "MoDuty" project path
       - dev-server.mjs / dev-all.mjs / vite / tsx watch / esbuild (MoDuty dev stack)
    2) any process listening on MoDuty dev ports 7238 / 6429 / 1420 (fallback)
  Unrelated Node (mcp-remote, other workspaces, remotion, MOMOKA_TS standalone) is NOT touched.
  Usage:
    .\stop-dev.ps1          # list then kill
    .\stop-dev.ps1 -DryRun  # list only
#>
param([switch]$DryRun)

$ErrorActionPreference = "Continue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$targets = @()
$killNames = @("node.exe", "esbuild.exe")

# --- 1. command-line matching ---
foreach ($name in $killNames) {
    Get-CimInstance Win32_Process -Filter "name='$name'" -ErrorAction SilentlyContinue | ForEach-Object {
        $cmd = $_.CommandLine
        if (-not $cmd) { return }
        $hit = ($cmd -match "MoDuty") -or
               ($cmd -match "dev-server\.mjs") -or
               ($cmd -match "dev-all\.mjs") -or
               ($cmd -match "node_modules[\\/]vite[\\/]bin") -or
               ($cmd -match "tsx(\.exe)?[\s']+watch") -or
               ($cmd -match "desktop[\\/]scripts[\\/]")
        if ($hit) {
            $targets += [PSCustomObject]@{ Pid = $_.ProcessId; Name = $_.Name; Cmd = $cmd }
        }
    }
}

# --- 2. port fallback: anything owning MoDuty dev ports ---
foreach ($port in @(7238, 6429, 1420)) {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object {
        $pidOwner = $_.OwningProcess
        $p = Get-CimInstance Win32_Process -Filter "ProcessId=$pidOwner" -ErrorAction SilentlyContinue
        if ($p) {
            $already = $targets | Where-Object { $_.Pid -eq $pidOwner }
            if (-not $already) {
                $targets += [PSCustomObject]@{ Pid = $pidOwner; Name = $p.Name; Cmd = $p.CommandLine }
            }
        }
    }
}

$targets = $targets | Sort-Object Pid -Unique

if ($targets.Count -eq 0) {
    Write-Host "[ok] nothing to stop: no MoDuty dev processes / port holders found." -ForegroundColor Green
    exit 0
}

Write-Host ("[i] {0} process(es) to stop:" -f $targets.Count) -ForegroundColor Yellow
$targets | ForEach-Object {
    $c = $_.Cmd; if ($c.Length -gt 200) { $c = $c.Substring(0, 200) }
    Write-Host ("    PID {0,-7} {1,-11} {2}" -f $_.Pid, $_.Name, $c)
}

if ($DryRun) {
    Write-Host "[i] -DryRun: listed only, nothing killed." -ForegroundColor Cyan
    exit 0
}

foreach ($t in $targets) {
    try {
        Stop-Process -Id $t.Pid -Force -ErrorAction Stop
        Write-Host ("[x] killed PID {0}" -f $t.Pid) -ForegroundColor Red
    } catch {
        Write-Host ("[!] failed to kill PID {0}: {1}" -f $t.Pid, $_.Exception.Message) -ForegroundColor Magenta
    }
}
Start-Sleep -Milliseconds 400

# report ports after cleanup
foreach ($port in @(7238, 6429, 1420)) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    if ($conn) { Write-Host ("[!] port {0} still busy" -f $port) -ForegroundColor Magenta }
    else { Write-Host ("[ok] port {0} free" -f $port) -ForegroundColor Green }
}
Write-Host "[done] MoDuty dev processes stopped. Restart anytime with ./run-all.ps1" -ForegroundColor Cyan
