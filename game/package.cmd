@echo off
rem Double-click to package EarthWalk as a standalone Windows game, and make an installer
rem when Inno Setup is installed. Close the Unreal editor first.
rem If Unreal is installed somewhere unusual, run:  package.cmd "D:\Path\To\UE_5.x"
setlocal
cd /d "%~dp0"

set "UE=%~1"
if defined UE goto :check
for /f "usebackq delims=" %%L in (`powershell -NoProfile -Command "$f = Join-Path $env:ProgramData 'Epic\UnrealEngineLauncher\LauncherInstalled.dat'; if (Test-Path $f) { (Get-Content $f -Raw | ConvertFrom-Json).InstallationList | Where-Object { $_.AppName -like 'UE_*' } | Sort-Object { [version]($_.AppName -replace 'UE_', '') } | Select-Object -Last 1 -ExpandProperty InstallLocation }"`) do set "UE=%%L"
if defined UE goto :check
for /d %%D in ("%ProgramFiles%\Epic Games\UE_*") do set "UE=%%D"
if defined UE goto :check
echo Could not find Unreal Engine. Install it with the Epic Games Launcher first.
goto :stop

:check
if exist "%UE%\Engine\Build\BatchFiles\RunUAT.bat" goto :package
echo Found "%UE%" but it does not look like an Unreal Engine install.
goto :stop

:package
echo Using Unreal Engine at: %UE%
echo.
echo Packaging. The first time takes 10-20 minutes and this window will look idle.
echo Using Unreal Engine at: %UE%> package-log.txt
call "%UE%\Engine\Build\BatchFiles\RunUAT.bat" BuildCookRun -project="%~dp0EarthWalk.uproject" -platform=Win64 -clientconfig=Shipping -build -cook -stage -pak -prereqs -archive -archivedirectory="%~dp0Packaged" -nop4 -utf8output -unattended >> package-log.txt 2>&1
if errorlevel 1 goto :failed
echo.
echo Packaged game: %~dp0Packaged\Windows\EarthWalk.exe

rem The installer needs Inno Setup (free):  winget install JRSoftware.InnoSetup
set "ISCC="
for %%P in ("%ProgramFiles(x86)%\Inno Setup 6\ISCC.exe" "%ProgramFiles%\Inno Setup 6\ISCC.exe" "%LocalAppData%\Programs\Inno Setup 6\ISCC.exe") do if exist "%%~P" set "ISCC=%%~P"
if not defined ISCC (
	echo.
	echo Inno Setup was not found, so no installer was made. To make one, install it with:
	echo     winget install JRSoftware.InnoSetup
	echo and run package.cmd again.
	goto :stop
)
set "VERSION=0.0.0"
for /f "tokens=2 delims==" %%V in ('findstr /b /c:"ProjectVersion=" "%~dp0Config\DefaultGame.ini"') do set "VERSION=%%V"
echo Making the installer for version %VERSION%...
"%ISCC%" /Q "/DAppVersion=%VERSION%" "%~dp0installer\EarthWalk.iss" >> package-log.txt 2>&1
if errorlevel 1 goto :failed
echo Installer: %~dp0Packaged\EarthWalk-Setup-%VERSION%.exe
echo Send that one file to family members; it installs the game and puts it in the Start menu.
goto :stop

:failed
echo.
echo The packaging did not succeed. The details are in package-log.txt, which is opening now.
echo Select everything in it, copy it, and send it to Claude.
start "" notepad "%~dp0package-log.txt"

:stop
echo.
pause
