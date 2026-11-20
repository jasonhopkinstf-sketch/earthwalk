using UnrealBuildTool;

public class EarthWalkEditorTarget : TargetRules
{
	public EarthWalkEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("EarthWalk");
	}
}
