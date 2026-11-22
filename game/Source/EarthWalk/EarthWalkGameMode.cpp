#include "EarthWalkGameMode.h"

#include "EarthLook.h"
#include "EarthSky.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/GameInstance.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/SkyLight.h"
#include "Engine/World.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

AEarthWalkGameMode::AEarthWalkGameMode()
{
	DefaultPawnClass = AEarthWalkCharacter::StaticClass();
	HUDClass = AEarthWalkHUD::StaticClass();
}

void AEarthWalkGameMode::InitGame(const FString& MapName, const FString& Options, FString& ErrorMessage)
{
	Super::InitGame(MapName, Options, ErrorMessage);

	UWorld* World = GetWorld();

	// The world must exist before the player spawns, so the player can ask it where the ground is.
	World->SpawnActor<AEarthWorld>();

	// Sky and lighting. The startup map is empty, so everything is created here.
	// A warm sun, a little lower than midday, so walls and roofs each get their own level of light.
	const FRotator SunAngle(-36.0, 135.0, 0.0);
	if (ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector, SunAngle))
	{
		if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
		{
			Light->SetMobility(EComponentMobility::Movable);
			Light->SetAtmosphereSunLight(true);
			Light->SetIntensity(8.f);
			Light->SetLightColor(FLinearColor(1.f, 0.94f, 0.84f));
			Light->SetDynamicShadowDistanceMovableLight(60000.f);
		}
	}
	World->SpawnActor<ASkyAtmosphere>();
	if (ASkyLight* Sky = World->SpawnActor<ASkyLight>())
	{
		if (USkyLightComponent* Light = Sky->GetLightComponent())
		{
			Light->SetMobility(EComponentMobility::Movable);
			Light->bRealTimeCapture = true;
			Light->MarkRenderStateDirty();
		}
	}
	AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>();
	// The painted sky with its drawn clouds; the engine's own clouds when that is off or not built.
	const UEarthWalkSettings* Settings = GetDefault<UEarthWalkSettings>();
	if (Settings->bPaintedSky && AEarthSky::Make(World, SunAngle.Vector()))
	{
		// The haze is for far land. The sky is painted with its own, and is the only thing this far away.
		if (Fog && Fog->GetComponent())
		{
			Fog->GetComponent()->SetFogCutoffDistance(static_cast<float>(AEarthSky::RadiusCm * 0.5));
		}
	}
	else
	{
		World->SpawnActor<AVolumetricCloud>();
	}

	// The drawn look: M_EarthInk (built by game\Tools\build-assets.cmd) over the whole view.
	UMaterialInterface* InkArt = Settings->bInkOutlines ? LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/EarthWalk/Materials/M_EarthInk.M_EarthInk")) : nullptr;
	if (APostProcessVolume* Volume = InkArt ? World->SpawnActor<APostProcessVolume>() : nullptr)
	{
		Volume->bUnbound = true;
		LookVolume = Volume;
		Ink = UMaterialInstanceDynamic::Create(InkArt, Volume);
		if (Ink)
		{
			// The look's own line and levels of light, then the InkTuning setting and -EWInk= on top.
			ApplyLook();
			Volume->Settings.WeightedBlendables.Array.Add(FWeightedBlendable(1.f, Ink));
		}
	}
}

void AEarthWalkGameMode::ApplyLook()
{
	EarthLook::TuneInk(Ink);
	if (LookVolume)
	{
		// A drawn picture is as bright at its corners as in the middle; the engine darkens them like a lens.
		LookVolume->Settings.bOverride_VignetteIntensity = EarthLook::Current() == EEarthLook::Flat;
		LookVolume->Settings.VignetteIntensity = 0.f;
	}
}

void AEarthWalkGameMode::StartPlay()
{
	Super::StartPlay();
	if (UGameInstance* Instance = GetGameInstance())
	{
		if (UEarthWalkNet* Net = Instance->GetSubsystem<UEarthWalkNet>())
		{
			Net->Connect();
		}
	}
}
