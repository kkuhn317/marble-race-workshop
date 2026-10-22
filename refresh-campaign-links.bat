@echo off
cd /d "%~dp0"
echo Scanning all workshop items, including custom uploads, for campaign matches.
echo Completed fingerprints are reused. New or changed archives will be downloaded.
node scan-workshop-duplicates.mjs --include-custom
if errorlevel 1 goto failed
echo.
echo Refresh Workshop Manager and click Publish changes to publish the campaign links.
pause
exit /b 0
:failed
echo Scan failed. Completed fingerprints are saved; you can run this again to resume.
pause
exit /b 1
