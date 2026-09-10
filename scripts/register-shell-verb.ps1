<#
.SYNOPSIS
    Register/Unregister MoDuty Right-click Menu Shell Verb (HKCU, no admin required)

.DESCRIPTION
    The command value does NOT call node.exe directly. Explorer launching a console
    program allocates a console window first (the flashing black window), so the
    command goes through moduty-launch.vbs, which starts the bridge hidden.

    Comments and output strings are ASCII-only on purpose: Windows PowerShell 5.1
    reads .ps1 as ANSI when there is no BOM, so non-ASCII text can be garbled or
    shift the parser under some locales.
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
$bridgeScript = Join-Path $scriptDir "shell-verb-bridge.mjs"
$launcherScript = Join-Path $scriptDir "moduty-launch.vbs"
$wscriptExe = Join-Path $env:SystemRoot "System32\wscript.exe"
$verbName = "MoDuty.SendToDispatcher"
$displayName = "Send to MoDuty Dispatcher"
$iconPath = Join-Path $env:SystemRoot "System32\shell32.dll"

function Get-CommandFor([string]$placeholder) {
    return "`"$wscriptExe`" //Nologo `"$launcherScript`" `"$placeholder`""
}

function Register-Verb {
    Write-Host "Registering Shell Verb: $displayName" -ForegroundColor Green

    foreach ($required in @($bridgeScript, $launcherScript, $wscriptExe)) {
        if (-not (Test-Path -LiteralPath $required)) {
            Write-Error "Missing required file: $required"
            exit 1
        }
    }

    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Warning "node not found in PATH. moduty-launch.vbs will fall back to Program Files\nodejs\node.exe."
    }

    # File context menu
    $keyFile = "HKCU:\Software\Classes\*\shell\$verbName"
    if (-not (Test-Path -LiteralPath $keyFile)) { New-Item -Path $keyFile -Force | Out-Null }
    New-ItemProperty -LiteralPath $keyFile -Name "(Default)" -Value $displayName -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $keyFile -Name "Icon" -Value $iconPath -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $keyFile -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null

    $cmdFile = Join-Path $keyFile "command"
    if (-not (Test-Path -LiteralPath $cmdFile)) { New-Item -Path $cmdFile -Force | Out-Null }
    New-ItemProperty -LiteralPath $cmdFile -Name "(Default)" -Value (Get-CommandFor "%1") -PropertyType ExpandString -Force | Out-Null

    # Folder context menu
    $keyDir = "HKCU:\Software\Classes\Directory\shell\$verbName"
    if (-not (Test-Path -LiteralPath $keyDir)) { New-Item -Path $keyDir -Force | Out-Null }
    New-ItemProperty -LiteralPath $keyDir -Name "(Default)" -Value $displayName -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $keyDir -Name "Icon" -Value $iconPath -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $keyDir -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null

    $cmdDir = Join-Path $keyDir "command"
    if (-not (Test-Path -LiteralPath $cmdDir)) { New-Item -Path $cmdDir -Force | Out-Null }
    New-ItemProperty -LiteralPath $cmdDir -Name "(Default)" -Value (Get-CommandFor "%1") -PropertyType ExpandString -Force | Out-Null

    # Desktop background context menu
    $keyBg = "HKCU:\Software\Classes\Directory\Background\shell\$verbName"
    if (-not (Test-Path -LiteralPath $keyBg)) { New-Item -Path $keyBg -Force | Out-Null }
    New-ItemProperty -LiteralPath $keyBg -Name "(Default)" -Value $displayName -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $keyBg -Name "Icon" -Value $iconPath -PropertyType String -Force | Out-Null
    New-ItemProperty -LiteralPath $keyBg -Name "Position" -Value "Top" -PropertyType String -Force | Out-Null

    $cmdBg = Join-Path $keyBg "command"
    if (-not (Test-Path -LiteralPath $cmdBg)) { New-Item -Path $cmdBg -Force | Out-Null }
    New-ItemProperty -LiteralPath $cmdBg -Name "(Default)" -Value (Get-CommandFor "%V") -PropertyType ExpandString -Force | Out-Null

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
        if (Test-Path -LiteralPath $key) {
            Remove-Item -LiteralPath $key -Recurse -Force -ErrorAction SilentlyContinue
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
        $exists = Test-Path -LiteralPath $key
        $status = if ($exists) { "Registered OK" } else { "Not registered" }
        Write-Host "  $key : $status"
        if ($exists) {
            $cmd = (Get-ItemProperty -LiteralPath (Join-Path $key "command") -ErrorAction SilentlyContinue)."(default)"
            Write-Host "      command: $cmd"
        }
    }
    Write-Host ""
    Write-Host "  launcher: $(if (Test-Path -LiteralPath $launcherScript) { $launcherScript } else { 'MISSING' })"
    Write-Host "  bridge  : $(if (Test-Path -LiteralPath $bridgeScript) { $bridgeScript } else { 'MISSING' })"
}

if ($Register) { Register-Verb }
elseif ($Unregister) { Unregister-Verb }
elseif ($Status) { Show-Status }
