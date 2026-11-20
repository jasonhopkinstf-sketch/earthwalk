using UnrealBuildTool;

public class EarthWalk : ModuleRules
{
	public EarthWalk(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[]
		{
			"Core", "CoreUObject", "Engine", "InputCore", "DeveloperSettings", "ProceduralMeshComponent"
		});
		PrivateDependencyModuleNames.AddRange(new string[]
		{
			"HTTP", "WebSockets", "Json", "Slate", "SlateCore"
		});
	}
}
