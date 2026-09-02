@echo off
cd /d "%~dp0"
node scan-workshop-duplicates.mjs
if errorlevel 1 goto failed
start "" "%~dp0duplicate-review.html"
echo.
echo Duplicate review page created and opened in your browser.
pause
exit /b 0
:failed
echo.
echo Duplicate scan failed. Completed fingerprints were saved and will be reused.
pause
exit /b 1
