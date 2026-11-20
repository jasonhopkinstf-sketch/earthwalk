#include "EarthWalkAssetsCommandlet.h"

#include "AssetImportTask.h"
#include "AssetToolsModule.h"
#include "Engine/Texture2D.h"
#include "Factories/MaterialFactoryNew.h"
#include "IAssetTools.h"
#include "MaterialEditingLibrary.h"
#include "Materials/Material.h"
#include "Materials/MaterialExpressionConstant.h"
#include "Materials/MaterialExpressionCustom.h"
#include "Materials/MaterialExpressionPerInstanceRandom.h"
#include "Materials/MaterialExpressionScalarParameter.h"
#include "Materials/MaterialExpressionTextureObjectParameter.h"
#include "Materials/MaterialExpressionTime.h"
#include "Materials/MaterialExpressionVectorParameter.h"
#include "Materials/MaterialExpressionVertexNormalWS.h"
#include "Materials/MaterialExpressionWorldPosition.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

DEFINE_LOG_CATEGORY_STATIC(LogEarthWalkAssets, Log, All);

namespace
{
	const TCHAR* const TexturePath = TEXT("/Game/EarthWalk/Textures");
	const TCHAR* const MaterialPath = TEXT("/Game/EarthWalk/Materials");

	// Names used by game/Tools/fetch-textures.ps1 and by AEarthWorld's surface table.
	const TCHAR* const TextureNames[] = {
		TEXT("plaster"), TEXT("brick"), TEXT("concrete"), TEXT("asphalt"), TEXT("grass"), TEXT("forest"), TEXT("sand"),
		TEXT("roof_clay"), TEXT("roof_grey"), TEXT("rock"), TEXT("gravel"), TEXT("soil"), TEXT("dirt"), TEXT("paving"),
	};

	/** Ground, roads and roofs: the texture is projected straight down and tinted by the server's colour. */
	const TCHAR* const TopCode = TEXT(R"HLSL(
float3 n = normalize(Normal);
float2 uv = WorldPos.xy / (100.0 * Repeat);
float3 tex = Texture2DSample(Albedo, AlbedoSampler, uv).rgb;
float2 nxy = Texture2DSample(NormalMap, NormalMapSampler, uv).rg * 2.0 - 1.0;
float3 nm = float3(nxy, sqrt(saturate(1.0 - dot(nxy, nxy)))); // two-channel normal map, rebuild z
float3 T = normalize(cross(float3(0.0, 1.0, 0.0), n));
float3 B = normalize(cross(n, T));
WorldNormal = normalize(nm.x * T + nm.y * B + nm.z * n);
Rough = Roughness;
return saturate(tex * lerp(1.0, Tint * 2.0, TintAmount));
)HLSL");

	/** Building walls: the texture runs along the wall and up it; a grid of windows is drawn on top. */
	const TCHAR* const WallCode = TEXT(R"HLSL(
float3 n = normalize(Normal);
float2 t2 = normalize(float2(n.y, -n.x) + float2(1e-4, 0.0));
float along = dot(WorldPos.xy, t2) / 100.0;
float height = WorldPos.z / 100.0;
float2 uv = float2(along, -height) / Repeat;
float3 tex = Texture2DSample(Albedo, AlbedoSampler, uv).rgb;
float2 nxy = Texture2DSample(NormalMap, NormalMapSampler, uv).rg * 2.0 - 1.0;
float3 nm = float3(nxy, sqrt(saturate(1.0 - dot(nxy, nxy)))); // two-channel normal map, rebuild z
float3 T = float3(t2, 0.0);
float3 B = float3(0.0, 0.0, -1.0);
float3 wn = normalize(nm.x * T + nm.y * B + nm.z * n);
float2 f = frac(float2(along / 2.4, height / 3.0));
float win = (f.x > 0.28 && f.x < 0.72 && f.y > 0.30 && f.y < 0.78) ? 1.0 : 0.0;
float frame = (f.x > 0.24 && f.x < 0.76 && f.y > 0.26 && f.y < 0.82) ? 1.0 : 0.0;
float3 wall = saturate(tex * 1.3 * lerp(1.0, Tint * 2.0, TintAmount));
float3 glass = float3(0.09, 0.12, 0.16) * (0.7 + 0.6 * nm.z);
float3 c = lerp(wall, float3(0.85, 0.85, 0.82), frame * Windows);
c = lerp(c, glass, win * Windows);
Rough = lerp(Roughness, 0.12, win * Windows);
WorldNormal = lerp(wn, n, win * Windows);
return c;
)HLSL");

	/** Water: the server's colour with gentle moving ripples. */
	const TCHAR* const WaterCode = TEXT(R"HLSL(
float2 p = WorldPos.xy / 100.0;
float a = sin(p.x * 0.9 + Time * 0.8) + sin((p.x + p.y) * 0.5 + Time * 0.6);
float b = sin(p.y * 1.1 - Time * 0.7) + sin((p.x - p.y) * 0.4 + Time * 0.5);
WorldNormal = normalize(float3(a * 0.02, b * 0.02, 1.0));
Rough = 0.08;
return Tint;
)HLSL");

	/** Tree canopies and trunks (instanced): the tint, varied per tree, with ruffled normals for leaves. */
	const TCHAR* const FoliageCode = TEXT(R"HLSL(
float3 p = WorldPos / 70.0;
float v = sin(p.x * 1.9 + p.y * 1.3) * sin(p.y * 1.7 + p.z * 2.1) * sin(p.z * 1.5 + p.x * 1.1);
float3 hue = lerp(float3(0.85, 1.05, 0.7), float3(1.1, 0.95, 0.75), Rand);
float3 c = Tint * hue * (0.8 + 0.3 * v);
float3 q = WorldPos / 9.0;
float3 bump = float3(sin(q.y * 1.3 + Rand * 6.0) * sin(q.z * 0.9), sin(q.z * 1.1 + Rand * 3.0) * sin(q.x * 0.8), sin(q.x * 1.2 + Rand) * sin(q.y * 0.7));
WorldNormal = normalize(normalize(Normal) + Fluff * 0.35 * bump);
Rough = 0.95;
return saturate(c);
)HLSL");

	bool SaveAsset(UObject* Asset)
	{
		UPackage* Package = Asset->GetOutermost();
		Package->MarkPackageDirty();
		const FString FileName = FPackageName::LongPackageNameToFilename(Package->GetName(), FPackageName::GetAssetPackageExtension());
		FSavePackageArgs Args;
		Args.TopLevelFlags = RF_Public | RF_Standalone;
		Args.SaveFlags = SAVE_NoError;
		const bool bSaved = UPackage::SavePackage(Package, Asset, *FileName, Args);
		UE_LOG(LogEarthWalkAssets, Display, TEXT("%s %s"), bSaved ? TEXT("Saved") : TEXT("FAILED to save"), *Package->GetName());
		return bSaved;
	}

	UTexture2D* ImportTexture(IAssetTools& Tools, const FString& File, const FString& Name, bool bNormalMap)
	{
		// Re-importing rewrites the (large) texture assets even when nothing changed, so keep existing ones.
		if (UTexture2D* Existing = LoadObject<UTexture2D>(nullptr, *FString::Printf(TEXT("%s/%s.%s"), TexturePath, *Name, *Name)))
		{
			return Existing;
		}
		UAssetImportTask* Task = NewObject<UAssetImportTask>();
		Task->AddToRoot();
		Task->Filename = File;
		Task->DestinationPath = TexturePath;
		Task->DestinationName = Name;
		Task->bAutomated = true;
		Task->bReplaceExisting = true;
		Task->bSave = false;
		TArray<UAssetImportTask*> Tasks;
		Tasks.Add(Task);
		Tools.ImportAssetTasks(Tasks);

		UTexture2D* Texture = nullptr;
		for (UObject* Object : Task->GetObjects())
		{
			if ((Texture = Cast<UTexture2D>(Object)) != nullptr)
			{
				break;
			}
		}
		Task->RemoveFromRoot();
		if (!Texture)
		{
			UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not import %s"), *File);
			return nullptr;
		}
		if (bNormalMap)
		{
			Texture->CompressionSettings = TC_Normalmap;
			Texture->SRGB = false;
			Texture->LODGroup = TEXTUREGROUP_WorldNormalMap;
		}
		else
		{
			Texture->LODGroup = TEXTUREGROUP_World;
		}
		Texture->PostEditChange();
		SaveAsset(Texture);
		return Texture;
	}

	UMaterial* FreshMaterial(IAssetTools& Tools, const FString& Name)
	{
		const FString ObjectPath = FString::Printf(TEXT("%s/%s.%s"), MaterialPath, *Name, *Name);
		if (UMaterial* Existing = LoadObject<UMaterial>(nullptr, *ObjectPath))
		{
			UMaterialEditingLibrary::DeleteAllMaterialExpressions(Existing);
			return Existing;
		}
		UMaterialFactoryNew* Factory = NewObject<UMaterialFactoryNew>();
		return Cast<UMaterial>(Tools.CreateAsset(Name, MaterialPath, UMaterial::StaticClass(), Factory));
	}

	template <class T>
	T* Node(UMaterial* Material, int32 X, int32 Y)
	{
		return Cast<T>(UMaterialEditingLibrary::CreateMaterialExpression(Material, T::StaticClass(), X, Y));
	}

	UMaterialExpressionScalarParameter* Scalar(UMaterial* Material, const TCHAR* Name, float Default, int32 Y)
	{
		UMaterialExpressionScalarParameter* Param = Node<UMaterialExpressionScalarParameter>(Material, -900, Y);
		Param->ParameterName = Name;
		Param->DefaultValue = Default;
		return Param;
	}

	UMaterialExpressionTextureObjectParameter* TextureObject(UMaterial* Material, const TCHAR* Name, UTexture* Default, int32 Y)
	{
		UMaterialExpressionTextureObjectParameter* Param = Node<UMaterialExpressionTextureObjectParameter>(Material, -900, Y);
		Param->ParameterName = Name;
		Param->Texture = Default;
		if (Default && Default->IsNormalMap())
		{
			Param->SamplerType = SAMPLERTYPE_Normal;
		}
		return Param;
	}

	/** One Custom HLSL node drives base colour, roughness and the world-space normal. */
	UMaterialExpressionCustom* CustomNode(UMaterial* Material, const TCHAR* Code, const TArray<FName>& InputNames)
	{
		UMaterialExpressionCustom* Custom = Node<UMaterialExpressionCustom>(Material, -300, 0);
		Custom->Code = Code;
		Custom->Description = TEXT("EarthWalk");
		Custom->OutputType = CMOT_Float3;
		Custom->Inputs.Reset();
		for (const FName& Name : InputNames)
		{
			FCustomInput Input;
			Input.InputName = Name;
			Custom->Inputs.Add(Input);
		}
		FCustomOutput Rough;
		Rough.OutputName = TEXT("Rough");
		Rough.OutputType = CMOT_Float1;
		Custom->AdditionalOutputs.Add(Rough);
		FCustomOutput Normal;
		Normal.OutputName = TEXT("WorldNormal");
		Normal.OutputType = CMOT_Float3;
		Custom->AdditionalOutputs.Add(Normal);
		Custom->RebuildOutputs();
		return Custom;
	}

	void Connect(UMaterialExpression* From, UMaterialExpressionCustom* Custom, const TCHAR* InputName)
	{
		if (!UMaterialEditingLibrary::ConnectMaterialExpressions(From, TEXT(""), Custom, InputName))
		{
			UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not connect %s"), InputName);
		}
	}

	void FinishMaterial(UMaterial* Material, UMaterialExpressionCustom* Custom)
	{
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT(""), MP_BaseColor);
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT("Rough"), MP_Roughness);
		UMaterialEditingLibrary::ConnectMaterialProperty(Custom, TEXT("WorldNormal"), MP_Normal);
		Material->bTangentSpaceNormal = false;
		UMaterialEditingLibrary::RecompileMaterial(Material);
		SaveAsset(Material);
	}

	void BuildTexturedMaterial(IAssetTools& Tools, const FString& Name, const TCHAR* Code, UTexture* Albedo, UTexture* NormalMap, bool bWindows)
	{
		UMaterial* Material = FreshMaterial(Tools, Name);
		if (!Material)
		{
			UE_LOG(LogEarthWalkAssets, Error, TEXT("Could not create material %s"), *Name);
			return;
		}
		TArray<FName> Inputs = { TEXT("WorldPos"), TEXT("Normal"), TEXT("Tint"), TEXT("Albedo"), TEXT("NormalMap"), TEXT("Repeat"), TEXT("TintAmount"), TEXT("Roughness") };
		if (bWindows)
		{
			Inputs.Add(TEXT("Windows"));
		}
		UMaterialExpressionCustom* Custom = CustomNode(Material, Code, Inputs);

		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor::White;

		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -300), Custom, TEXT("WorldPos"));
		Connect(Node<UMaterialExpressionVertexNormalWS>(Material, -900, -150), Custom, TEXT("Normal"));
		Connect(Tint, Custom, TEXT("Tint"));
		Connect(TextureObject(Material, TEXT("Albedo"), Albedo, 150), Custom, TEXT("Albedo"));
		Connect(TextureObject(Material, TEXT("NormalMap"), NormalMap, 300), Custom, TEXT("NormalMap"));
		Connect(Scalar(Material, TEXT("Repeat"), 3.f, 450), Custom, TEXT("Repeat"));
		Connect(Scalar(Material, TEXT("TintAmount"), 0.5f, 550), Custom, TEXT("TintAmount"));
		Connect(Scalar(Material, TEXT("Roughness"), 0.85f, 650), Custom, TEXT("Roughness"));
		if (bWindows)
		{
			Connect(Scalar(Material, TEXT("Windows"), 1.f, 750), Custom, TEXT("Windows"));
		}
		FinishMaterial(Material, Custom);
	}

	void BuildFoliageMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthFoliage"));
		if (!Material)
		{
			return;
		}
		UMaterialExpressionCustom* Custom = CustomNode(Material, FoliageCode, { TEXT("WorldPos"), TEXT("Normal"), TEXT("Tint"), TEXT("Rand"), TEXT("Fluff") });
		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor(0.2f, 0.5f, 0.18f);
		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -300), Custom, TEXT("WorldPos"));
		Connect(Node<UMaterialExpressionVertexNormalWS>(Material, -900, -150), Custom, TEXT("Normal"));
		Connect(Tint, Custom, TEXT("Tint"));
		Connect(Node<UMaterialExpressionPerInstanceRandom>(Material, -900, 150), Custom, TEXT("Rand"));
		Connect(Scalar(Material, TEXT("Fluff"), 1.f, 300), Custom, TEXT("Fluff"));
		// Leaves and bark are matt: almost no specular highlight.
		UMaterialExpressionConstant* Matt = Node<UMaterialExpressionConstant>(Material, -300, 400);
		Matt->R = 0.08f;
		UMaterialEditingLibrary::ConnectMaterialProperty(Matt, TEXT(""), MP_Specular);
		Material->bUsedWithInstancedStaticMeshes = true;
		FinishMaterial(Material, Custom);
	}

	void BuildWaterMaterial(IAssetTools& Tools)
	{
		UMaterial* Material = FreshMaterial(Tools, TEXT("M_EarthWater"));
		if (!Material)
		{
			return;
		}
		UMaterialExpressionCustom* Custom = CustomNode(Material, WaterCode, { TEXT("WorldPos"), TEXT("Tint"), TEXT("Time") });
		UMaterialExpressionVectorParameter* Tint = Node<UMaterialExpressionVectorParameter>(Material, -900, 0);
		Tint->ParameterName = TEXT("Color");
		Tint->DefaultValue = FLinearColor(0.25f, 0.5f, 0.71f);
		Connect(Node<UMaterialExpressionWorldPosition>(Material, -900, -300), Custom, TEXT("WorldPos"));
		Connect(Tint, Custom, TEXT("Tint"));
		Connect(Node<UMaterialExpressionTime>(Material, -900, 150), Custom, TEXT("Time"));
		FinishMaterial(Material, Custom);
	}
}

UEarthWalkAssetsCommandlet::UEarthWalkAssetsCommandlet()
{
	IsClient = false;
	IsServer = false;
	IsEditor = true;
	LogToConsole = true;
}

int32 UEarthWalkAssetsCommandlet::Main(const FString& Params)
{
	IAssetTools& Tools = FModuleManager::LoadModuleChecked<FAssetToolsModule>("AssetTools").Get();
	const FString TextureDir = FPaths::ProjectDir() / TEXT("Textures");

	TMap<FString, UTexture2D*> Textures;
	int32 Missing = 0;
	for (const TCHAR* Name : TextureNames)
	{
		for (const TCHAR* Kind : { TEXT("D"), TEXT("N") })
		{
			const FString File = TextureDir / FString::Printf(TEXT("%s_%s.jpg"), Name, Kind);
			const FString AssetName = FString::Printf(TEXT("T_%s_%s"), Name, Kind);
			if (!FPaths::FileExists(File))
			{
				UE_LOG(LogEarthWalkAssets, Error, TEXT("Missing %s. Run game\\Tools\\fetch-textures.ps1 first."), *File);
				++Missing;
				continue;
			}
			if (UTexture2D* Texture = ImportTexture(Tools, File, AssetName, FCString::Strcmp(Kind, TEXT("N")) == 0))
			{
				Textures.Add(AssetName, Texture);
			}
		}
	}
	if (Missing > 0)
	{
		return 1;
	}

	BuildTexturedMaterial(Tools, TEXT("M_EarthTop"), TopCode, Textures.FindRef(TEXT("T_grass_D")), Textures.FindRef(TEXT("T_grass_N")), false);
	BuildTexturedMaterial(Tools, TEXT("M_EarthWall"), WallCode, Textures.FindRef(TEXT("T_plaster_D")), Textures.FindRef(TEXT("T_plaster_N")), true);
	BuildWaterMaterial(Tools);
	BuildFoliageMaterial(Tools);

	UE_LOG(LogEarthWalkAssets, Display, TEXT("EarthWalk assets built: %d textures, 4 materials under /Game/EarthWalk"), Textures.Num());
	return 0;
}
