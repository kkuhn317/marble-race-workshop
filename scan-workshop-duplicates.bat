@echo off
cd /d "%~dp0"
node scan-workshop-duplicates.mjs
if errorlevel 1 goto failed
echo.
if defined MARBLE_REVIEW_URL (
  start "" "%MARBLE_REVIEW_URL%"
  echo Duplicate review page created and opened through Workshop Manager.
  pause
  exit /b 0
)
echo Starting an authorized Workshop Manager session for the review page.
echo Keep this window open while reviewing and applying choices.
node workshop-manager.mjs --review --port 0
exit /b %errorlevel%
:failed
echo.
echo Duplicate scan failed. Completed fingerprints were saved and will be reused.
pause
exit /b 1
