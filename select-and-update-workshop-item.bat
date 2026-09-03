@echo off
setlocal
cd /d "%~dp0"
title Update Marble Race Workshop Item

powershell.exe -NoLogo -NoProfile -STA -ExecutionPolicy Bypass -File "%~dp0select-and-update-workshop-item.ps1" -ItemId %1
if errorlevel 1 goto failed

echo.
echo Update tool finished.
pause
exit /b 0

:failed
echo.
echo The update tool stopped because of an error.
pause
exit /b 1
