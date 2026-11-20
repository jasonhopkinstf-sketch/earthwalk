using UnrealBuildTool;

public class EarthWalkTarget : TargetRules
{
	public EarthWalkTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("EarthWalk");
	}
}
