#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthSky.generated.h"

class UMaterialInstanceDynamic;
class UStaticMeshComponent;

/**
 * The painted sky: a great ball round the player, drawn on the inside with M_EarthSky (built by
 * game\Tools\build-assets.cmd): a gradient, a drawn sun and cartoon clouds. It stays centred on the
 * camera, so the sky never gets nearer. The engine's own atmosphere is still there for the haze over
 * far land and for the colour of the sunlight; this only replaces what the sky looks like, and the
 * sky light takes its colour from it.
 */
UCLASS()
class AEarthSky : public AActor
{
	GENERATED_BODY()

public:
	AEarthSky();

	virtual void Tick(float DeltaSeconds) override;

	/**
	 * Spawns the sky with the sun drawn where the light comes from (SunTravels is the way the light
	 * goes). Null when the sky's material has not been built, so the caller can fall back to the
	 * engine's clouds. -EWSky=Name:value,Name:value tries other settings for one run (Bright, CloudBright, Clouds,
	 * CloudInk, Drift, SunSize; the list is in EarthWalkAssetsCommandlet.cpp).
	 */
	static AEarthSky* Make(UWorld* World, const FVector& SunTravels);

	/** Far enough to lie behind everything, the photographic world from the air included. */
	static constexpr double RadiusCm = 20000000.0;

private:
	UPROPERTY()
	TObjectPtr<UStaticMeshComponent> Dome;

	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> Paint;
};
