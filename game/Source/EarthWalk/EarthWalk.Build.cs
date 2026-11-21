using System.IO;
using System.Linq;
using UnrealBuildTool;

public class EarthWalk : ModuleRules
{
	public EarthWalk(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		// Each source file is compiled by itself. Joined together (a "unity" build), small helpers of the same
		// name in two files clash, and which files are joined changes from one build to the next.
		bUseUnity = false;

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
		// Only in the editor build, which is also what runs the game on the PC that has the plugin
		// (UnrealEditor -game). The standalone game target turns the plugin off (EarthWalk.Target.cs).
		bool bCesium = Target.Type == TargetType.Editor && PluginRoots.Any(Root => Root != null && Directory.Exists(Root) &&
			Directory.EnumerateFiles(Root, "CesiumForUnreal.uplugin", SearchOption.AllDirectories).Any());
		if (bCesium)
		{
			PrivateDependencyModuleNames.Add("CesiumRuntime");
		}
		PublicDefinitions.Add("EARTHWALK_CESIUM=" + (bCesium ? "1" : "0"));
	}
}
