using UnrealBuildTool;

public class EarthWalkTarget : TargetRules
{
	public EarthWalkTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("EarthWalk");
		// The Cesium plugin (the photographic world) is not part of this standalone game, even when it is
		// packaged on a PC that has the plugin: EarthWalk.uproject allows it for the Editor target only,
		// and EarthWalk.Build.cs links it only there.
	}
}
