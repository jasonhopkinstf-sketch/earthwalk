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

#if EARTHWALK_CESIUM
namespace
{
	/** Sets a true/false setting of the tileset that the plugin exposes to the editor but gives no C++ setter. */
	void SetTilesetFlag(ACesium3DTileset* Tileset, const TCHAR* Name, bool bValue)
	{
		if (const FBoolProperty* Property = FindFProperty<FBoolProperty>(ACesium3DTileset::StaticClass(), Name))
		{
			Property->SetPropertyValue_InContainer(Tileset, bValue);
		}
	}
}
#endif

bool EarthPhoto::IsBuiltIn()
{
	return EARTHWALK_CESIUM != 0;
}

void EarthPhoto::SetOrigin(UWorld* World, double Lat, double Lon, double HeightMeters)
{
#if EARTHWALK_CESIUM
	if (ACesiumGeoreference* Georeference = World ? ACesiumGeoreference::GetDefaultGeoreference(World) : nullptr)
	{
		Georeference->SetOriginLongitudeLatitudeHeight(FVector(Lon, Lat, HeightMeters));
	}
#endif
}

AActor* EarthPhoto::SpawnTileset(UWorld* World, const FString& GoogleMapTilesKey, bool bWalkable)
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
	// Collision is only worth preparing for tiles somebody will stand on; without it they load faster.
	Tileset->SetCreatePhysicsMeshes(bWalkable);
	// Google's terms need the attribution on screen, not behind a "data attribution" link.
	SetTilesetFlag(Tileset, TEXT("ShowCreditsOnScreen"), true);
	// -EWPhotoStats writes the plugin's tile selection statistics to the log, for working out slow loading.
	if (FParse::Param(FCommandLine::Get(), TEXT("EWPhotoStats")))
	{
		SetTilesetFlag(Tileset, TEXT("LogSelectionStats"), true);
	}
	Tileset->FinishSpawning(Transform);
	return Tileset;
#else
	return nullptr;
#endif
}

void EarthPhoto::SetSuspended(AActor* Tileset, bool bSuspended)
{
#if EARTHWALK_CESIUM
	if (ACesium3DTileset* Tiles = Cast<ACesium3DTileset>(Tileset))
	{
		SetTilesetFlag(Tiles, TEXT("SuspendUpdate"), bSuspended);
	}
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

void EarthPhoto::SampleHeights(AActor* Tileset, const TArray<FVector2D>& LatLon, TFunction<void(const TArray<double>& Heights, const TArray<bool>& Found)> Done)
{
	const int32 Num = LatLon.Num();
#if EARTHWALK_CESIUM
	if (ACesium3DTileset* Tiles = Cast<ACesium3DTileset>(Tileset))
	{
		TArray<FVector> Places;
		Places.Reserve(Num);
		for (const FVector2D& Place : LatLon)
		{
			Places.Add(FVector(Place.Y, Place.X, 0.0)); // the plugin wants longitude first
		}
		Tiles->SampleHeightMostDetailed(Places, FCesiumSampleHeightMostDetailedCallback::CreateLambda(
			[Done, Num](ACesium3DTileset*, const TArray<FCesiumSampleHeightResult>& Results, const TArray<FString>&)
			{
				TArray<double> Heights;
				TArray<bool> Found;
				Heights.Init(0.0, Num);
				Found.Init(false, Num);
				for (int32 i = 0; i < FMath::Min(Num, Results.Num()); ++i)
				{
					Found[i] = Results[i].SampleSuccess;
					Heights[i] = Results[i].LongitudeLatitudeHeight.Z;
				}
				Done(Heights, Found);
			}));
		return;
	}
#endif
	TArray<double> Heights;
	TArray<bool> Found;
	Heights.Init(0.0, Num);
	Found.Init(false, Num);
	Done(Heights, Found);
}

void EarthPhoto::SampleGround(UWorld* World, AActor* Tileset, double Lat, double Lon, TFunction<void(bool bFound, double Z)> Done)
{
	const TWeakObjectPtr<UWorld> WeakWorld(World);
	SampleHeights(Tileset, {FVector2D(Lat, Lon)}, [WeakWorld, Lat, Lon, Done](const TArray<double>& Heights, const TArray<bool>& Found)
	{
#if EARTHWALK_CESIUM
		UWorld* Now = WeakWorld.Get();
		const ACesiumGeoreference* Georeference = Now ? ACesiumGeoreference::GetDefaultGeoreference(Now) : nullptr;
		if (Georeference && Found.Num() > 0 && Found[0])
		{
			// The quarter turn is about the vertical, so the georeference's own Z is ours too.
			Done(true, Georeference->TransformLongitudeLatitudeHeightPositionToUnreal(FVector(Lon, Lat, Heights[0])).Z);
			return;
		}
#endif
		Done(false, 0.0);
	});
}
