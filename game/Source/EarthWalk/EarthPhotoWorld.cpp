#include "EarthPhotoWorld.h"

#include "Engine/World.h"
#include "GameFramework/Actor.h"

#if EARTHWALK_CESIUM
#include "Cesium3DTileset.h"
#include "CesiumGeoreference.h"
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
