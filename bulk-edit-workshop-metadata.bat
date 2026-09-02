@echo off
setlocal

cd /d "%~dp0"
node bulk-edit-workshop-metadata.mjs
if errorlevel 1 goto failed

echo.
echo Finished.
pause
exit /b 0

:failed
echo.
echo Bulk editing failed. Nothing was deployed after a failed validation.
pause
exit /b 1
