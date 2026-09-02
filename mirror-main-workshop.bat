@echo off
setlocal
cd /d "%~dp0"

node mirror-main-workshop.mjs
if errorlevel 1 goto failed

echo.
echo Finished.
pause
exit /b 0

:failed
echo.
echo Mirror stopped. Completed R2 uploads were checkpointed and can be resumed by running this file again.
pause
exit /b 1
