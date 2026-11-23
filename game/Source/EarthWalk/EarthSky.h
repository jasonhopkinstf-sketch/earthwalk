#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthSkyMath.h"
#include "EarthSky.generated.h"

class UDirectionalLightComponent;
class UExponentialHeightFogComponent;
class UInstancedStaticMeshComponent;
class UMaterialInstanceDynamic;
class USkyAtmosphereComponent;
class USkyLightComponent;
class UStaticMeshComponent;

/**
 * The painted sky: a great ball round the player, drawn on the inside with M_EarthSky (built by
 * game\Tools\build-assets.cmd): a gradient, a drawn sun and cartoon clouds. It stays centred on the
 * camera, so the sky never gets nearer. The engine's own atmosphere is still there for the haze over
 * far land and for the colour of the sunlight; this only replaces what the sky looks like, and the
 * sky light takes its colour from it.
 *
 * It is also where the hour and the weather reach the picture (PaintHour, called by UEarthWeather): the
 * colours of the air, the sun, the moon with its real phase, the stars, how many clouds there are, the
 * one light that casts (the sun's, then the moon's or starlight's), the light from all round, the haze,
 * and what falls: rain and snow, as small shapes in a box that stays round the camera.
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

	/** Sets the sky for the look in use (EarthLook.h); /look calls it. */
	void ApplyLook();

	/** The sky of a world, or null when it has none (the painted sky turned off, or not built). */
	static AEarthSky* Get(UWorld* World);
	/** The lights the hour and the weather act on: the game mode hands them over when it has made them. */
	void SetLights(UDirectionalLightComponent* InSun, USkyLightComponent* InAllRound, UExponentialHeightFogComponent* InFog, USkyAtmosphereComponent* InAir);
	/**
	 * The hour and the weather. ToSun and ToMoon are steps towards them (no moon: null); Clouds is how many of the
	 * sky's places hold a cloud; DriftAt how much further round the wind has carried them than a fine day's breeze;
	 * the haze begins FogNearM off and is whole by FogFarM; Flash is a flash of lightning, sinking back to 0.
	 */
	void PaintHour(const EarthSkyMath::FLight& Light, const FVector& ToSun, const FVector* ToMoon, double Clouds, double DriftAt, double FogNearM, double FogFarM, double Flash);
	/** What falls: every streak of rain and flake of snow, where it is now (engine units, in the world), and the rain's colour. Empty lists for none. */
	void SetFall(const TArray<FTransform>& Rain, const TArray<FTransform>& Snow, const FLinearColor& RainColour, const FLinearColor& SnowColour);

	/** Far enough to lie behind everything, the photographic world from the air included. */
	static constexpr double RadiusCm = 20000000.0;

private:
	UPROPERTY()
	TObjectPtr<UStaticMeshComponent> Dome;

	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> Paint;

	UPROPERTY()
	TObjectPtr<UInstancedStaticMeshComponent> RainShapes;

	UPROPERTY()
	TObjectPtr<UInstancedStaticMeshComponent> SnowShapes;

	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> RainPaint;

	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> SnowPaint;

	TWeakObjectPtr<UDirectionalLightComponent> Sun;
	TWeakObjectPtr<USkyLightComponent> AllRound;
	TWeakObjectPtr<UExponentialHeightFogComponent> Fog;
	TWeakObjectPtr<USkyAtmosphereComponent> Air;
	// The haze as the game mode made it: a fine day's, which the weather thickens.
	float FogDensity = 0.02f;
	float FogFalloff = 0.2f;
	float FogStart = 0.f;
	int32 RainShown = 0;
	int32 SnowShown = 0;
};
