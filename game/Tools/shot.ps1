# Starts the game, takes one screenshot and quits: for checking the look without playing.
# The picture goes to game\Saved\Shots\<Name>.png. The access code is read from this PC's saved
# settings and never printed.
#
#   .\shot.ps1 -Name street -Extra @('-EWYaw=138', '-EWView=2', '-EWWalk')
#
# -Extra takes any of the game's own switches (README, "Art assets and the look").
param(
    [Parameter(Mandatory = $true)][string]$Name,
    [double]$Lat = -36.95108,
    [double]$Lon = 174.63034,
    [string[]]$Extra = @(),
    [string]$Engine = 'C:\Program Files\Epic Games\UE_5.8'
)
$game = Split-Path -Parent $PSScriptRoot
$ini = Get-Content "$game\Saved\Config\WindowsEditor\GameUserSettings.ini"
$inSec = $false; $code = $null
foreach ($l in $ini) {
    if ($l -match '^\[(.+)\]') { $inSec = ($Matches[1] -eq 'EarthWalk') }
    elseif ($inSec -and $l -match '^Code=(.*)$') { $code = $Matches[1].Trim('"') }
}
if (-not $code) { 'no access code found'; exit 1 }
$dir = "$game\Saved\Shots"
New-Item -ItemType Directory -Force $dir | Out-Null
$shot = "$dir\$Name.png"
if (Test-Path $shot) { Remove-Item $shot -Confirm:$false }
$list = @("$game\EarthWalk.uproject", '-game', '-windowed', '-ResX=1280', '-ResY=720', "-EWCode=$code", "-EWLat=$Lat", "-EWLon=$Lon", "-EWShot=$shot") + $Extra
$p = Start-Process -FilePath "$Engine\Engine\Binaries\Win64\UnrealEditor.exe" -ArgumentList $list -PassThru
if (-not $p.WaitForExit(300000)) { $p.Kill(); 'timed out, killed' }
"exit=$($p.ExitCode) shot=$(Test-Path $shot)"
