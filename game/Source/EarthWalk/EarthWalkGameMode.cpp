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
	UDirectionalLightComponent* SunLight = nullptr;
	USkyLightComponent* AllRound = nullptr;
	if (ADirectionalLight* Sun = World->SpawnActor<ADirectionalLight>(FVector::ZeroVector, SunAngle))
	{
		if (UDirectionalLightComponent* Light = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
		{
			SunLight = Light;
			Light->SetMobility(EComponentMobility::Movable);
			Light->SetAtmosphereSunLight(true);
			Light->SetIntensity(8.f);
			Light->SetLightColor(FLinearColor(1.f, 0.94f, 0.84f));
			Light->SetDynamicShadowDistanceMovableLight(60000.f);
		}
	}
	ASkyAtmosphere* Air = World->SpawnActor<ASkyAtmosphere>();
	if (ASkyLight* Sky = World->SpawnActor<ASkyLight>())
	{
		if (USkyLightComponent* Light = Sky->GetLightComponent())
		{
			AllRound = Light;
			Light->SetMobility(EComponentMobility::Movable);
			Light->bRealTimeCapture = true;
			Light->MarkRenderStateDirty();
		}
	}
	AExponentialHeightFog* Fog = World->SpawnActor<AExponentialHeightFog>();
	// The painted sky with its drawn clouds; the engine's own clouds when that is off or not built.
	const UEarthWalkSettings* Settings = GetDefault<UEarthWalkSettings>();
	AEarthSky* Painted = Settings->bPaintedSky ? AEarthSky::Make(World, SunAngle.Vector()) : nullptr;
	if (Painted)
	{
		// The hour and the weather reach the lights through the sky (UEarthWeather).
		Painted->SetLights(SunLight, AllRound, Fog ? Fog->GetComponent() : nullptr, Air ? Air->GetComponent() : nullptr);
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
			FString Kept;
			bLines = !(FEarthWalkConfig::HasOverride(TEXT("Lines"), Kept) && Kept.Equals(TEXT("off"), ESearchCase::IgnoreCase));
			Volume->Settings.WeightedBlendables.Array.Add(FWeightedBlendable(bLines ? 1.f : 0.f, Ink));
		}
	}
}

namespace
{
	/**
	 * The flat look's night: how much darker its paint is drawn, how many times brighter than its paint a lamp must be to be
	 * let through, how bright a lamp is drawn, and how many stops darker the whole picture is on top of the other look's
	 * night (the engine sets the picture's brightness by what is on it, and so makes up for some of the darker paint).
	 * -EWFlatNight=<dim>,<glow at>,<glow gain>,<stops> tries other numbers, for pictures.
	 */
	const TArray<float>& FlatNight()
	{
		static const TArray<float> Tuned = []()
		{
			TArray<float> Out = { 0.72f, 1.6f, 1.0f, 1.3f };
			FString Text;
			if (FParse::Value(FCommandLine::Get(), TEXT("-EWFlatNight="), Text, false))
			{
				TArray<FString> Parts;
				Text.ParseIntoArray(Parts, TEXT(","));
				for (int32 i = 0; i < FMath::Min(Parts.Num(), Out.Num()); ++i)
				{
					Out[i] = FCString::Atof(*Parts[i]);
				}
			}
			return Out;
		}();
		return Tuned;
	}
}

void AEarthWalkGameMode::SetAir(double Mist, double NearM, double FarM, double Night, const FLinearColor& Hour)
{
	if (LookVolume)
	{
		// The flat look's colours are its surfaces' own, whatever the light: the hour's colour is laid over the whole
		// picture instead. (Only its colour: how dark the night is shown is the line below, for both looks.)
		const bool bFlat = EarthLook::Current() == EEarthLook::Flat;
		const float Lum = FMath::Max(0.299f * Hour.R + 0.587f * Hour.G + 0.114f * Hour.B, 0.2f);
		LookVolume->Settings.bOverride_ColorGain = bFlat;
		LookVolume->Settings.ColorGain = FVector4(Hour.R / Lum, Hour.G / Lum, Hour.B / Lum, 1.0);
		LookVolume->Settings.bOverride_AutoExposureBias = true;
		// (1 is the engine's own setting for a view that sets none, which is what this view had until now.)
		LookVolume->Settings.AutoExposureBias = static_cast<float>(1.0 - (0.85 + (bFlat ? FlatNight()[3] : 0.0)) * FMath::Clamp(Night, 0.0, 1.0));
	}
	if (Ink)
	{
		// The flat look's paint is its own colour whatever the light, so its night is made in the ink pass: everything
		// that is lit drawn darker, and the lamps in the windows (lit as EarthWeather lights them) let through.
		const TArray<float>& Tuned = FlatNight();
		const bool bFlat = EarthLook::Current() == EEarthLook::Flat;
		const float Dark = bFlat ? static_cast<float>(FMath::Clamp(Night, 0.0, 1.0)) : 0.f;
		Ink->SetScalarParameterValue(TEXT("NightDim"), Tuned[0] * Dark);
		Ink->SetScalarParameterValue(TEXT("NightGlow"), bFlat ? static_cast<float>(FMath::SmoothStep(0.35, 0.75, Night)) : 0.f);
		Ink->SetScalarParameterValue(TEXT("GlowAt"), Tuned[1]);
		// (The hour's colour is laid over the whole flat picture afterwards, ColorGain above, and at night that is a strong
		// blue: the lamp's warm yellow is given here with that taken out again, or it would come out white.)
		const float Lum = FMath::Max(0.299f * Hour.R + 0.587f * Hour.G + 0.114f * Hour.B, 0.2f);
		const FLinearColor Lamp(1.0f, 0.74f, 0.30f);
		Ink->SetScalarParameterValue(TEXT("GlowR"), Tuned[2] * Lamp.R / FMath::Max(Hour.R / Lum, 0.25f));
		Ink->SetScalarParameterValue(TEXT("GlowG"), Tuned[2] * Lamp.G / FMath::Max(Hour.G / Lum, 0.25f));
		Ink->SetScalarParameterValue(TEXT("GlowB"), Tuned[2] * Lamp.B / FMath::Max(Hour.B / Lum, 0.25f));
	}
	if (!Ink || FMath::Abs(Mist - AirMist) < 0.01)
	{
		return;
	}
	AirMist = Mist;
	EarthLook::TuneInk(Ink); // the look's own line
	const float Misty = static_cast<float>(FMath::Clamp(Mist * 2.0, 0.0, 1.0));
	if (Misty > 0.f)
	{
		float Start = 12000.f, End = 60000.f, Far = 0.25f;
		Ink->GetScalarParameterValue(FHashedMaterialParameterInfo(TEXT("FadeStart")), Start);
		Ink->GetScalarParameterValue(FHashedMaterialParameterInfo(TEXT("FadeEnd")), End);
		Ink->GetScalarParameterValue(FHashedMaterialParameterInfo(TEXT("InkFar")), Far);
		Ink->SetScalarParameterValue(TEXT("FadeStart"), FMath::Lerp(Start, static_cast<float>(NearM * 100.0), Misty));
		Ink->SetScalarParameterValue(TEXT("FadeEnd"), FMath::Lerp(End, static_cast<float>(FarM * 100.0), Misty));
		Ink->SetScalarParameterValue(TEXT("InkFar"), FMath::Lerp(Far, 0.f, Misty));
	}
}

void AEarthWalkGameMode::SetLines(bool bOn)
{
	bLines = bOn;
	FEarthWalkConfig::Save(TEXT("Lines"), bOn ? TEXT("on") : TEXT("off"));
	if (LookVolume && LookVolume->Settings.WeightedBlendables.Array.Num() > 0)
	{
		LookVolume->Settings.WeightedBlendables.Array[0].Weight = bOn ? 1.f : 0.f;
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
