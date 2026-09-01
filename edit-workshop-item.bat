@echo off
setlocal

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0edit-workshop-item.ps1"
if errorlevel 1 goto failed

echo.
echo Finished.
pause
exit /b 0

:failed
echo.
echo Editing failed. Any validation changes were rolled back.
pause
exit /b 1
