Set-Location "d:\OBSIDIAN\SyrVault1\21_软件\Project_KivoLAPIX\MOMOKA_TS"

Write-Host "=== Step 0: Clean port 8888 if occupied ==="
try {
    $conn = Get-NetTCPConnection -LocalPort 8888 -ErrorAction Stop
    if ($conn) {
        $conn | ForEach-Object {
            Write-Host "Killing process ID: $($_.OwningProcess)"
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep -Seconds 2
        Write-Host "Port 8888 cleared."
    }
} catch {
    Write-Host "Port 8888 is free."
}

Write-Host ""
Write-Host "=== Step 1: npm run build ==="
$buildOutput = & npm run build 2>&1
$buildExit = $LASTEXITCODE
Write-Host "Build output:"
$buildOutput | ForEach-Object { Write-Host $_ }
Write-Host "Build exit code: $buildExit"

if ($buildExit -ne 0) {
    Write-Host "Build FAILED. Exiting."
    exit 1
}

Write-Host ""
Write-Host "=== Step 2: Start server in background ==="
$proc = Start-Process -FilePath "node" -ArgumentList "dist/server.js" -PassThru -NoNewWindow
Write-Host "Server PID: $($proc.Id)"

Write-Host "Waiting 3 seconds..."
Start-Sleep -Seconds 3

Write-Host ""
Write-Host "=== Step 3: Check health ==="
try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:8888/api/health" -UseBasicParsing -TimeoutSec 5
    Write-Host "Health check status: $($response.StatusCode)"
    Write-Host "Health check response:"
    Write-Host $response.Content
} catch {
    Write-Host "Health check FAILED: $($_.Exception.Message)"
    if ($_.Exception.Response) {
        $reader = New-Object System.IO.StreamReader($_.Exception.Response.GetResponseStream())
        Write-Host "Response: $($reader.ReadToEnd())"
    }
}

Write-Host ""
Write-Host "=== Done ==="