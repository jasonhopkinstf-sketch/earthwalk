@echo off
rem Rebuilds the world materials under game\Content\EarthWalk from code.
rem Only needed after changing EarthWalkAssetsCommandlet.cpp; the results
rem are committed. Close the Unreal editor first. The game must have been built (game\build.cmd).
setlocal
cd /d "%~dp0.."

set "UE=%~1"
if defined UE goto :check
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "$f = Join-Path $env:ProgramData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'; if (Test-Path $f) { (Get-Content $f -Raw | ConvertFrom-Json).InstallationList | Where-Object { $_.AppName -like 'UE_*' } | Sort-Object { [version]($_.AppName -replace 'UE_', '') } | Select-Object -Last 1 -ExpandProperty InstallLocation }"`) do set "UE=%%L"
if defined UE goto :check
for /d %%D in ("%ProgramFiles%\Epic Games\UE_*") do set "UE=%%D"
if defined UE goto :check
echo Could not find Unreal Engine. Install it with the Epic Games Launcher first.
goto :stop

:check
if exist "%UE%\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" goto :run
echo Found "%UE%" but it does not look like an Unreal Engine install.
goto :stop

:run
echo Building materials (a minute or two)...
"%UE%\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "%cd%\EarthWalk.uproject" -run=EarthWalkAssets -unattended -nopause -nosplash -stdout -FullStdOutLogOutput > assets-log.txt 2>&1
if errorlevel 1 goto :failed
echo Done. The assets are in game\Content\EarthWalk; commit them.
goto :stop

:failed
echo.
echo Building the assets did not succeed. The details are in game\assets-log.txt.

:stop
echo.
pause
