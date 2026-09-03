@echo off
setlocal
cd /d "%~dp0"
title Publish Marble Race Workshop Items

powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0select-and-publish-workshop-item.ps1"
if errorlevel 1 goto failed

echo.
echo Publisher finished.
pause
exit /b 0

:failed
echo.
echo The publisher stopped because of an error.
pause
exit /b 1
