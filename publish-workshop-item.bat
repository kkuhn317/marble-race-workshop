@echo off
setlocal

if "%~1"=="" (
  echo Drag a Marble Race ZIP or RAR file onto this BAT file.
  echo.
  echo You can also run:
  echo   publish-workshop-item.bat "C:\path\to\My Level.zip"
  echo.
  pause
  exit /b 1
)

:publish_next
echo.
echo Publishing: %~1
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-workshop-item.ps1" -ArchivePath "%~1"
if errorlevel 1 goto failed

shift
if not "%~1"=="" goto publish_next

echo.
echo Finished.
pause
exit /b 0

:failed
echo.
echo Publishing failed. Nothing after the failed validation was deployed.
pause
exit /b 1
