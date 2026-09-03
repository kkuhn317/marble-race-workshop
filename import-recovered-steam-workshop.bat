@echo off
setlocal
cd /d "%~dp0"
title Import Recovered Steam Workshop

node import-recovered-steam-workshop.mjs
if errorlevel 1 goto failed

echo.
echo Finished.
pause
exit /b 0

:failed
echo.
echo Import stopped. Prepared files and completed R2 uploads were checkpointed.
echo Fix the reported problem, then run this file again to resume.
pause
exit /b 1
