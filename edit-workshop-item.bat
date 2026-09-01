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
echo Editing failed. Check the message above. Prepared changes may still be present if validation had already passed.
pause
exit /b 1
