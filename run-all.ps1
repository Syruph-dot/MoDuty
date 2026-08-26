$ErrorActionPreference = "Continue"
Set-Location "d:\OBSIDIAN\SyrVault1\21_软件\Project_KivoLAPIX\MOMOKA_TS"
$outFile = "d:\OBSIDIAN\SyrVault1\21_软件\Project_KivoLAPIX\MOMOKA_TS\all-output.txt"

"=== $(Get-Date) Step 0: Clean port 8888 ===" | Out-File $outFile -Encoding utf8
try {
    $conn = Get-NetTCPConnection -LocalPort 8888 -ErrorAction Stop
    if ($conn) {
        $conn | ForEach-Object {
            "Killing PID $($_.OwningProcess)" | Out-File $outFile -Append -Encoding utf8
            Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue
        }
        Start-Sleep 2
    }
} catch {
    "Port 8888 is free" | Out-File $outFile -Append -Encoding utf8
}

"=== $(Get-Date) Step 1: npm run build ===" | Out-File $outFile -Append -Encoding utf8
& npm run build 2>&1 | Out-File $outFile -Append -Encoding utf8
"Build exit code: $LASTEXITCODE" | Out-File $outFile -Append -Encoding utf8

"=== $(Get-Date) Step 2: Start server ===" | Out-File $outFile -Append -Encoding utf8
$proc = Start-Process -FilePath "node" -ArgumentList "dist/server.js" -PassThru -RedirectStandardOutput "server-stdout.log" -RedirectStandardError "server-stderr.log" -NoNewWindow
"Server PID: $($proc.Id)" | Out-File $outFile -Append -Encoding utf8

Start-Sleep 3

"=== $(Get-Date) Step 3: Health check ===" | Out-File $outFile -Append -Encoding utf8
try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:8888/api/health" -UseBasicParsing -TimeoutSec 5
    "Status: $($r.StatusCode)" | Out-File $outFile -Append -Encoding utf8
    "Body: $($r.Content)" | Out-File $outFile -Append -Encoding utf8
} catch {
    "Health check FAILED: $($_.Exception.Message)" | Out-File $outFile -Append -Encoding utf8
}

"=== $(Get-Date) Server stdout ===" | Out-File $outFile -Append -Encoding utf8
Get-Content "server-stdout.log" -ErrorAction SilentlyContinue | Out-File $outFile -Append -Encoding utf8
"=== $(Get-Date) Server stderr ===" | Out-File $outFile -Append -Encoding utf8
Get-Content "server-stderr.log" -ErrorAction SilentlyContinue | Out-File $outFile -Append -Encoding utf8

"=== $(Get-Date) ALL DONE ===" | Out-File $outFile -Append -Encoding utf8