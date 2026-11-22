# Compiles the editor build of the game without the prompts of game\build.cmd, for running unattended.
# Refuses while the Unreal editor (or the game run from it) is open. The full log is game\build-log.txt.
param([string]$Engine = 'C:\Program Files\Epic Games\UE_5.8')
$game = Split-Path -Parent $PSScriptRoot
Set-Location $game
if (Get-Process UnrealEditor -ErrorAction SilentlyContinue) { 'The Unreal editor is running; not building.'; exit 1 }
cmd /c "`"$Engine\Engine\Build\BatchFiles\Build.bat`" EarthWalkEditor Win64 Development -Project=`"$game\EarthWalk.uproject`" -WaitMutex > build-log.txt 2>&1"
"exit=$LASTEXITCODE"
Select-String -Path build-log.txt -Pattern 'error|warning C|Result:|Total execution' | Select-Object -First 60 | ForEach-Object { $_.Line }
