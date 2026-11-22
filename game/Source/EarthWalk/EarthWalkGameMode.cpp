#include "EarthWalkGameMode.h"

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
	UMaterialInterface* Ink = Settings->bInkOutlines ? LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/EarthWalk/Materials/M_EarthInk.M_EarthInk")) : nullptr;
	if (APostProcessVolume* Volume = Ink ? World->SpawnActor<APostProcessVolume>() : nullptr)
	{
		Volume->bUnbound = true;
		if (UMaterialInstanceDynamic* Tuned = UMaterialInstanceDynamic::Create(Ink, Volume))
		{
			for (const TPair<FString, float>& Pair : Settings->InkTuning)
			{
				Tuned->SetScalarParameterValue(FName(*Pair.Key), Pair.Value);
			}
			// -EWInk=Band1:0.9,InkWidth:2 tries values for one run.
			FString Tries;
			if (FParse::Value(FCommandLine::Get(), TEXT("-EWInk="), Tries, /*bShouldStopOnSeparator*/ false))
			{
				TArray<FString> Parts;
				Tries.ParseIntoArray(Parts, TEXT(","));
				for (const FString& Part : Parts)
				{
					FString Name, Value;
					if (Part.Split(TEXT(":"), &Name, &Value))
					{
						Tuned->SetScalarParameterValue(FName(*Name.TrimStartAndEnd()), FCString::Atof(*Value));
					}
				}
			}
			Volume->Settings.WeightedBlendables.Array.Add(FWeightedBlendable(1.f, Tuned));
		}
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
