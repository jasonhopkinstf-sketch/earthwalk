; Inno Setup script for the EarthWalk Windows installer. Built by game\package.cmd after
; packaging, with the version passed in:  ISCC.exe /DAppVersion=0.1.0 EarthWalk.iss
; It installs the packaged game, the Windows components Unreal games need, and shortcuts.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{7D2C3E8A-5B61-4F0E-9C8B-2E6A1F4D9B37}
AppName=EarthWalk
AppVersion={#AppVersion}
AppVerName=EarthWalk {#AppVersion}
AppPublisher=EarthWalk
DefaultDirName={autopf}\EarthWalk
DefaultGroupName=EarthWalk
DisableProgramGroupPage=yes
OutputDir=..\Packaged
OutputBaseFilename=EarthWalk-Setup-{#AppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\EarthWalk.exe
PrivilegesRequired=admin

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"

[Files]
Source: "..\Packaged\Windows\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[Icons]
Name: "{group}\EarthWalk"; Filename: "{app}\EarthWalk.exe"
Name: "{group}\Uninstall EarthWalk"; Filename: "{uninstallexe}"
Name: "{autodesktop}\EarthWalk"; Filename: "{app}\EarthWalk.exe"; Tasks: desktopicon

[Run]
; The Visual C++ runtime, shipped by Unreal when packaging with -prereqs (older engines named it UEPrereqSetup_x64.exe).
Filename: "{app}\Engine\Extras\Redist\en-us\vc_redist.x64.exe"; Parameters: "/install /quiet /norestart"; StatusMsg: "Installing Windows components the game needs..."; Flags: waituntilterminated; Check: FileExists(ExpandConstant('{app}\Engine\Extras\Redist\en-us\vc_redist.x64.exe'))
Filename: "{app}\Engine\Extras\Redist\en-us\UEPrereqSetup_x64.exe"; Parameters: "/quiet /norestart"; StatusMsg: "Installing Windows components the game needs..."; Flags: waituntilterminated; Check: FileExists(ExpandConstant('{app}\Engine\Extras\Redist\en-us\UEPrereqSetup_x64.exe'))
Filename: "{app}\EarthWalk.exe"; Description: "{cm:LaunchProgram,EarthWalk}"; Flags: nowait postinstall skipifsilent
