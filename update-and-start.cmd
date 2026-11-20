@echo off
rem Double-click to get the latest EarthWalk and start the world server.
setlocal
cd /d "%~dp0"

where git >nul 2>nul
if errorlevel 1 (
  echo Git is not installed. Get it from https://git-scm.com/download/win and run this again.
  goto :stop
)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get the LTS version from https://nodejs.org and run this again.
  goto :stop
)

git diff --quiet
if errorlevel 1 goto :changed
git diff --cached --quiet
if errorlevel 1 goto :changed

echo Getting the latest version...
git checkout main
if errorlevel 1 goto :failed
git pull --ff-only origin main
if errorlevel 1 goto :failed

cd server
echo Installing what the server needs...
call npm.cmd ci --omit=dev
if errorlevel 1 goto :failed

echo.
echo Starting the world. Open http://localhost:8787 in your browser.
echo Close this window to stop it.
echo.
call npm.cmd start
goto :stop

:changed
echo Some files in this folder were edited on this PC, so updating could overwrite them.
echo Nothing was changed. Ask Claude what to do, and mention this message.
goto :stop

:failed
echo.
echo Something went wrong above. Nothing else was changed. Copy the text above and send it to Claude.

:stop
echo.
pause
