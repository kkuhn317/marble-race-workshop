@echo off
setlocal
cd /d "%~dp0"
title Marble Race Workshop Manager
node workshop-manager.mjs
if errorlevel 1 (
  echo.
  echo The Workshop Manager stopped because of an error.
  pause
)
