<#
.SYNOPSIS
    Register/Unregister MoDuty Right-click Menu Shell Verb (HKCU, no admin required)
#>

param(
    [Parameter(Mandatory=$true, ParameterSetName='Register')]
    [switch]$Register,

    [Parameter(Mandatory=$true, ParameterSetName='Unregister')]
    [switch]$Unregister,

    [Parameter(Mandatory=$true, ParameterSetName='Status')]
    [switch]$Status
)

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$projectRoot = Split-Path -Parent $scriptDir
$bridgeScript = $scriptDir + "\shell-verb-bridge.mjs"
$nodeExe = (Get-Command node).Source
$verbName = "MoDuty.SendToDispatcher"
$displayName = "Send to MoDuty Dispatcher"
$iconPath = $env:SystemRoot + "\System32\shell32.dll"

function Register-Verb {
    Write-Host "Registering Shell Verb: $displayName" -ForegroundColor Green

    if (-not (Test-Path $bridgeScript)) {
        Write-Error "Bridge script not found: $bridgeScript"
        exit 1
    }

    # HKCU:\Software\Classes\*\shell\MoDuty.SendToDispatcher (file context menu)
    $keyFile = "HKCU:\Software\Classes\*\shell\$verbName"
    if (-not (Test-Path $keyFile)) { New-Item -Path $keyFile -Force | Out-Null }
    New-ItemProperty -Path $keyFile -Name "(Default)" -Value $displayName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $keyFile -Name "Icon" -Value $iconPath -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $keyFile -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null

    $cmdFile = $keyFile + "\command"
    if (-not (Test-Path $cmdFile)) { New-Item -Path $cmdFile -Force | Out-Null }
    $command = "`"$nodeExe`" `"$bridgeScript`" `"%1`""
    New-ItemProperty -Path $cmdFile -Name "(Default)" -Value $command -PropertyType ExpandString -Force | Out-Null

    # HKCU:\Software\Classes\Directory\shell\MoDuty.SendToDispatcher (folder context menu)
    $keyDir = "HKCU:\Software\Classes\Directory\shell\$verbName"
    if (-not (Test-Path $keyDir)) { New-Item -Path $keyDir -Force | Out-Null }
    New-ItemProperty -Path $keyDir -Name "(Default)" -Value $displayName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $keyDir -Name "Icon" -Value $iconPath -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $keyDir -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null

    $cmdDir = $keyDir + "\command"
    if (-not (Test-Path $cmdDir)) { New-Item -Path $cmdDir -Force | Out-Null }
    New-ItemProperty -Path $cmdDir -Name "(Default)" -Value $command -PropertyType ExpandString -Force | Out-Null

    # HKCU:\Software\Classes\Directory\Background\shell\MoDuty.SendToDispatcher (desktop background)
    $keyBg = "HKCU:\Software\Classes\Directory\Background\shell\$verbName"
    if (-not (Test-Path $keyBg)) { New-Item -Path $keyBg -Force | Out-Null }
    New-ItemProperty -Path $keyBg -Name "(Default)" -Value $displayName -PropertyType String -Force | Out-Null
    New-ItemProperty -Path $keyBg -Name "Icon" -Value $iconPath -PropertyType String -Force | Out-Null

    $cmdBg = $keyBg + "\command"
    if (-not (Test-Path $cmdBg)) { New-Item -Path $cmdBg -Force | Out-Null }
    $commandBg = "`"$nodeExe`" `"$bridgeScript`" `"%V`""
    New-ItemProperty -Path $cmdBg -Name "(Default)" -Value $commandBg -PropertyType ExpandString -Force | Out-Null

    Write-Host "Shell Verb registered!" -ForegroundColor Green
    Write-Host "  - File context menu: OK"
    Write-Host "  - Folder context menu: OK"
    Write-Host "  - Desktop background menu: OK"
    Write-Host ""
    Write-Host "Please reopen Explorer windows or re-login to take effect."
}

function Unregister-Verb {
    Write-Host "Unregistering Shell Verb: $displayName" -ForegroundColor Yellow

    $keys = @(
        "HKCU:\Software\Classes\*\shell\$verbName",
        "HKCU:\Software\Classes\Directory\shell\$verbName",
        "HKCU:\Software\Classes\Directory\Background\shell\$verbName"
    )

    foreach ($key in $keys) {
        if (Test-Path $key) {
            Remove-Item -Path $key -Recurse -Force -ErrorAction SilentlyContinue
            Write-Host "  Removed: $key"
        }
    }

    Write-Host "Shell Verb unregistered!" -ForegroundColor Green
    Write-Host "Please reopen Explorer windows or re-login to take effect."
}

function Show-Status {
    $keys = @(
        "HKCU:\Software\Classes\*\shell\$verbName",
        "HKCU:\Software\Classes\Directory\shell\$verbName",
        "HKCU:\Software\Classes\Directory\Background\shell\$verbName"
    )

    Write-Host "MoDuty Shell Verb Status:" -ForegroundColor Cyan
    foreach ($key in $keys) {
        $exists = Test-Path $key
        $status = if ($exists) { "Registered OK" } else { "Not registered" }
        Write-Host "  $key : $status"
    }
}

if ($Register) { Register-Verb }
elseif ($Unregister) { Unregister-Verb }
elseif ($Status) { Show-Status }