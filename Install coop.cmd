@echo off
setlocal
title Install coop
echo(
echo   Installing coop - this sets up everything and may take a few minutes.
echo   Leave this window open until it finishes; you can watch the steps below.
echo(
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0bin\coop.ps1" install
set "RC=%ERRORLEVEL%"
echo(
if "%RC%"=="0" (
  echo   All set. You can close this window, then double-click the coop icon
  echo   on your Desktop or in the Start Menu to launch coop.
) else (
  echo   Something went wrong ^(exit code %RC%^). Scroll up to read the messages,
  echo   or ask a teammate for help.
)
echo(
pause
endlocal
