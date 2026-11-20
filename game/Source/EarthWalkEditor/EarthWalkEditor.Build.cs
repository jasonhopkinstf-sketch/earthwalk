using UnrealBuildTool;

// Editor-only tools: the commandlet that imports the world textures and builds the materials.
public class EarthWalkEditor : ModuleRules
{
	public EarthWalkEditor(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;

		PublicDependencyModuleNames.AddRange(new string[] { "Core", "CoreUObject", "Engine" });
		PrivateDependencyModuleNames.AddRange(new string[] { "EarthWalk", "UnrealEd", "AssetTools", "MaterialEditor" });
	}
}
