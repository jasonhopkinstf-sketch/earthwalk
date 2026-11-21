using UnrealBuildTool;

public class EarthWalkTarget : TargetRules
{
	public EarthWalkTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("EarthWalk");

		// The standalone game the family installs leaves the Cesium plugin out, even when it is packaged
		// on a PC that has it. The photographic world is an experiment for the PC that holds the Google
		// key (README), and it is reached through the editor build there. EarthWalk.Build.cs matches this.
		DisablePlugins.Add("CesiumForUnreal");
	}
}
