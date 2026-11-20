@echo off
rem Double-click to build the EarthWalk Unreal game. Close the Unreal editor first.
rem If Unreal is installed somewhere unusual, run:  build.cmd "D:\Path\To\UE_5.x"
setlocal
cd /d "%~dp0"

rem Step 1: fetch the latest version, then start again from the updated copy of this file.
set "UE=%~1"
if /i "%~1"=="--no-update" set "UE=%~2"
if /i "%~1"=="--no-update" goto :find
where git >nul 2>nul
if errorlevel 1 goto :find
echo Getting the latest version...
(git pull --ff-only origin main & "%~f0" --no-update "%UE%")

:find
if defined UE goto :check
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "$f = Join-Path $env:ProgramData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'; if (Test-Path $f) { (Get-Content $f -Raw | ConvertFrom-Json).InstallationList | Where-Object { $_.AppName -like 'UE_*' } | Sort-Object { [version]($_.AppName -replace 'UE_', '') } | Select-Object -Last 1 -ExpandProperty InstallLocation }"`) do set "UE=%%L"
if defined UE goto :check
for /d %%D in ("%ProgramFiles%\Epic Games\UE_*") do set "UE=%%D"
if defined UE goto :check
echo Could not find Unreal Engine. Install it with the Epic Games Launcher first.
goto :stop

:check
if exist "%UE%\Engine\Build\BatchFiles\Build.bat" goto :build
echo Found "%UE%" but it does not look like an Unreal Engine install.
goto :stop

:build
echo Using Unreal Engine at: %UE%
echo.
echo Building. The first time takes several minutes and this window will look idle.
echo Using Unreal Engine at: %UE%> build-log.txt
call "%UE%\Engine\Build\BatchFiles\Build.bat" EarthWalkEditor Win64 Development -Project="%~dp0EarthWalk.uproject" -WaitMutex >> build-log.txt 2>&1
if errorlevel 1 goto :failed

echo.
echo Build succeeded.
choice /c YN /m "Open EarthWalk in Unreal now"
if errorlevel 2 goto :stop
start "" "%UE%\Engine\Binaries\Win64\UnrealEditor.exe" "%~dp0EarthWalk.uproject"
goto :end

:failed
echo.
echo The build did not succeed. The details are in build-log.txt, which is opening now.
echo Select everything in it, copy it, and send it to Claude.
start "" notepad "%~dp0build-log.txt"

:stop
echo.
pause
:end
