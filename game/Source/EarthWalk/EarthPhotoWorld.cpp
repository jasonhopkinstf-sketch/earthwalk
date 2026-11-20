#include "EarthPhotoWorld.h"

#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

#if EARTHWALK_CESIUM
#include "Cesium3DTileset.h"
#include "CesiumGeoreference.h"
#include "CesiumSampleHeightResult.h"
#include "UObject/UnrealType.h"
#endif

bool EarthPhoto::IsBuiltIn()
{
	return EARTHWALK_CESIUM != 0;
}

void EarthPhoto::SetOrigin(UWorld* World, double Lat, double Lon)
{
#if EARTHWALK_CESIUM
	if (ACesiumGeoreference* Georeference = World ? ACesiumGeoreference::GetDefaultGeoreference(World) : nullptr)
	{
		Georeference->SetOriginLongitudeLatitudeHeight(FVector(Lon, Lat, 0.0));
	}
#endif
}

AActor* EarthPhoto::SpawnTileset(UWorld* World, const FString& GoogleMapTilesKey)
{
#if EARTHWALK_CESIUM
	if (!World || GoogleMapTilesKey.IsEmpty())
	{
		return nullptr;
	}
	// A quarter turn takes Cesium's east (+X) to our east (+Y) and its south (+Y) to our south (-X).
	// Checked from the air over Titirangi against the generated world: streets, coast and bush line up.
	const FTransform Transform(FRotator(0.0, 90.0, 0.0));
	ACesium3DTileset* Tileset = World->SpawnActorDeferred<ACesium3DTileset>(ACesium3DTileset::StaticClass(), Transform);
	if (!Tileset)
	{
		return nullptr;
	}
	Tileset->SetTilesetSource(ETilesetSource::FromUrl);
	Tileset->SetUrl(FString::Printf(TEXT("https://tile.googleapis.com/v1/3dtiles/root.json?key=%s"), *GoogleMapTilesKey));
	// Google's terms need the attribution on screen, not behind a "data attribution" link.
	if (const FBoolProperty* OnScreen = FindFProperty<FBoolProperty>(ACesium3DTileset::StaticClass(), TEXT("ShowCreditsOnScreen")))
	{
		OnScreen->SetPropertyValue_InContainer(Tileset, true);
	}
	// -EWPhotoStats writes the plugin's tile selection statistics to the log, for working out slow loading.
	if (FParse::Param(FCommandLine::Get(), TEXT("EWPhotoStats")))
	{
		if (const FBoolProperty* Stats = FindFProperty<FBoolProperty>(ACesium3DTileset::StaticClass(), TEXT("LogSelectionStats")))
		{
			Stats->SetPropertyValue_InContainer(Tileset, true);
		}
	}
	Tileset->FinishSpawning(Transform);
	return Tileset;
#else
	return nullptr;
#endif
}

float EarthPhoto::LoadProgress(const AActor* Tileset)
{
#if EARTHWALK_CESIUM
	if (ACesium3DTileset* Tiles = Cast<ACesium3DTileset>(const_cast<AActor*>(Tileset)))
	{
		return Tiles->GetLoadProgress();
	}
#endif
	return 0.f;
}

void EarthPhoto::SampleGround(UWorld* World, AActor* Tileset, double Lat, double Lon, TFunction<void(bool bFound, double Z)> Done)
{
#if EARTHWALK_CESIUM
	if (ACesium3DTileset* Tiles = World ? Cast<ACesium3DTileset>(Tileset) : nullptr)
	{
		const TWeakObjectPtr<UWorld> WeakWorld(World);
		Tiles->SampleHeightMostDetailed({FVector(Lon, Lat, 0.0)}, FCesiumSampleHeightMostDetailedCallback::CreateLambda(
			[WeakWorld, Done](ACesium3DTileset*, const TArray<FCesiumSampleHeightResult>& Results, const TArray<FString>&)
			{
				UWorld* Now = WeakWorld.Get();
				const ACesiumGeoreference* Georeference = Now ? ACesiumGeoreference::GetDefaultGeoreference(Now) : nullptr;
				if (!Georeference || Results.Num() == 0 || !Results[0].SampleSuccess)
				{
					Done(false, 0.0);
					return;
				}
				// The quarter turn is about the vertical, so the georeference's own Z is ours too.
				Done(true, Georeference->TransformLongitudeLatitudeHeightPositionToUnreal(Results[0].LongitudeLatitudeHeight).Z);
			}));
		return;
	}
#endif
	Done(false, 0.0);
}
