using System.IO;
using System.Linq;
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

		// The photographic world (EarthPhotoWorld.h) needs the Cesium for Unreal plugin, which is optional:
		// without it the game builds as before and stays on the generated world.
		string[] PluginRoots =
		{
			Path.Combine(EngineDirectory, "Plugins", "Marketplace"),
			Target.ProjectFile != null ? Path.Combine(Target.ProjectFile.Directory.FullName, "Plugins") : null,
		};
		bool bCesium = PluginRoots.Any(Root => Root != null && Directory.Exists(Root) &&
			Directory.EnumerateFiles(Root, "CesiumForUnreal.uplugin", SearchOption.AllDirectories).Any());
		if (bCesium)
		{
			PrivateDependencyModuleNames.Add("CesiumRuntime");
		}
		PublicDefinitions.Add("EARTHWALK_CESIUM=" + (bCesium ? "1" : "0"));
	}
}
