@echo off
rem stop-dev.cmd - double-click helper that runs stop-dev.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-dev.ps1"
echo.
pause
