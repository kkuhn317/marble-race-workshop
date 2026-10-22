@echo off
cd /d "%~dp0"
echo Checking for new or changed workshop items, including custom uploads.
echo Existing campaign links and review choices will be preserved.
node scan-new-campaign-links.mjs
if errorlevel 1 goto failed
echo.
echo Refresh Workshop Manager and click Publish changes to publish the campaign links.
pause
exit /b 0
:failed
echo Scan failed. Completed fingerprints are saved; you can run this again to resume.
pause
exit /b 1
