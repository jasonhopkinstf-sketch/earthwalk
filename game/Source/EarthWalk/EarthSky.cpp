#include "EarthSky.h"

#include "EarthLook.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "EngineUtils.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "UObject/ConstructorHelpers.h"

AEarthSky::AEarthSky()
{
	PrimaryActorTick.bCanEverTick = true;
	PrimaryActorTick.TickGroup = TG_PostUpdateWork; // after the camera has moved

	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	Dome = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Dome"));
	RootComponent = Dome;
	Dome->SetStaticMesh(Sphere.Object);
	Dome->SetMobility(EComponentMobility::Movable);
	Dome->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Dome->SetCastShadow(false);
	Dome->bAffectDynamicIndirectLighting = false;
	Dome->bAffectDistanceFieldLighting = false;
	Dome->SetGenerateOverlapEvents(false);
	// The engine's sphere is 50 cm in radius.
	Dome->SetWorldScale3D(FVector(RadiusCm / 50.0));

	// What falls: small boxes, placed in the world one by one (UEarthWeather works out where), whatever the dome does.
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	const auto Shapes = [this](const TCHAR* Name)
	{
		UInstancedStaticMeshComponent* Made = CreateDefaultSubobject<UInstancedStaticMeshComponent>(Name);
		Made->SetupAttachment(Dome);
		Made->SetUsingAbsoluteLocation(true);
		Made->SetUsingAbsoluteRotation(true);
		Made->SetUsingAbsoluteScale(true);
		Made->SetStaticMesh(Cube.Object);
		Made->SetMobility(EComponentMobility::Movable);
		Made->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Made->SetCastShadow(false);
		Made->bAffectDynamicIndirectLighting = false;
		Made->bAffectDistanceFieldLighting = false;
		Made->SetGenerateOverlapEvents(false);
		return Made;
	};
	RainShapes = Shapes(TEXT("Rain"));
	SnowShapes = Shapes(TEXT("Snow"));
	LeafShapes = Shapes(TEXT("Leaves"));
}

AEarthSky* AEarthSky::Get(UWorld* World)
{
	if (World)
	{
		for (TActorIterator<AEarthSky> It(World); It; ++It)
		{
			return *It;
		}
	}
	return nullptr;
}

void AEarthSky::SetLights(UDirectionalLightComponent* InSun, USkyLightComponent* InAllRound, UExponentialHeightFogComponent* InFog, USkyAtmosphereComponent* InAir)
{
	Sun = InSun;
	AllRound = InAllRound;
	Fog = InFog;
	Air = InAir;
	if (InFog)
	{
		FogDensity = InFog->FogDensity;
		FogFalloff = InFog->FogHeightFalloff;
		FogStart = InFog->StartDistance;
	}
	if (InAir)
	{
		// The engine's air goes on colouring the light and the haze as for the fine day's high sun, wherever the light
		// that casts really is: a low sun or a moon is given its colour by EarthSkyMath, and is not reddened and dimmed twice.
		const EarthSkyMath::FSun Fine = EarthSkyMath::FineDay();
		InAir->OverrideAtmosphereLightDirection(0, EarthSkyMath::Direction(Fine.Alt, Fine.Az));
	}
}

void AEarthSky::PaintHour(const EarthSkyMath::FLight& L, const FVector& ToSun, const FVector* ToMoon, double Clouds, double DriftAt, double FogNearM, double FogFarM, double Flash)
{
	const auto Lum = [](const FLinearColor& C) { return 0.299 * C.R + 0.587 * C.G + 0.114 * C.B; };
	if (UMaterialInstanceDynamic* Sky = this->Paint)
	{
		const auto Colour = [Sky](const TCHAR* Name, const FLinearColor& C) { Sky->SetVectorParameterValue(Name, FLinearColor(C.R, C.G, C.B)); };
		Sky->SetVectorParameterValue(TEXT("Sun"), FLinearColor(ToSun.X, ToSun.Y, ToSun.Z));
		if (ToMoon)
		{
			Sky->SetVectorParameterValue(TEXT("Moon"), FLinearColor(ToMoon->X, ToMoon->Y, ToMoon->Z));
		}
		Colour(TEXT("Zenith"), L.Zenith);
		Colour(TEXT("Mid"), L.Mid);
		Colour(TEXT("Horizon"), L.Horizon);
		Colour(TEXT("FlatSky"), L.FlatSky);
		Colour(TEXT("Glow"), L.Glow);
		Colour(TEXT("Dusk"), L.DuskGlow);
		Colour(TEXT("Land"), L.Land);
		Colour(TEXT("SunDisc"), L.SunDisc);
		Colour(TEXT("CloudLit"), L.Cloud);
		Colour(TEXT("CloudShade"), L.CloudShade);
		Colour(TEXT("MistColour"), L.FogColour);
		Sky->SetScalarParameterValue(TEXT("SunShow"), static_cast<float>(L.SunShow));
		Sky->SetScalarParameterValue(TEXT("Stars"), static_cast<float>(L.Stars));
		Sky->SetScalarParameterValue(TEXT("MoonShow"), ToMoon ? static_cast<float>(L.MoonShow) : 0.f);
		Sky->SetScalarParameterValue(TEXT("MoonGlow"), static_cast<float>(L.MoonGlow));
		Sky->SetScalarParameterValue(TEXT("Mist"), static_cast<float>(L.Mist));
		Sky->SetScalarParameterValue(TEXT("Clouds"), static_cast<float>(Clouds));
		Sky->SetScalarParameterValue(TEXT("DriftAt"), static_cast<float>(DriftAt));
	}
	// The one light that casts. Its colour and strength are told against a fine noon's, which is what this game's sun was made as.
	if (UDirectionalLightComponent* Cast = Sun.Get())
	{
		const FVector ToCaster = EarthSkyMath::Direction(L.CastAlt, L.CastAz);
		Cast->SetWorldRotation((-ToCaster).Rotation());
		Cast->SetLightColor(FLinearColor(1.f * L.CastColour.R / 1.0f, 0.94f * L.CastColour.G / 0.89f, 0.84f * L.CastColour.B / 0.72f));
		Cast->SetIntensity(static_cast<float>(8.0 * (L.CastStrength / 2.1) * (1.0 + Flash * 0.5)));
	}
	// The light from all round is taken from the painted sky by the engine. A night sky is dark, and the night here
	// is bright on purpose (never black), so the light is turned up by as much as the sky has gone down.
	if (USkyLightComponent* Round = AllRound.Get())
	{
		const double Wanted = Lum(L.SkyColour) * L.SkyStrength / 1.15;
		const double SkyNow = FMath::Lerp((Lum(L.Zenith) + 2.0 * Lum(L.Mid) + Lum(L.Horizon)) / 4.0, Lum(L.FogColour), L.Mist) / 0.3745;
		Round->SetIntensity(static_cast<float>(FMath::Clamp(Wanted / FMath::Max(SkyNow, 0.05), 0.6, 7.0) * (1.0 + Flash)));
	}
	// The haze: a fine day's is the engine's own, as it always was; rain, snow and fog bring it nearer and make it grey.
	if (UExponentialHeightFogComponent* Haze = Fog.Get())
	{
		const double Thicker = FMath::Clamp(1700.0 / FMath::Max(FogFarM - FogNearM, 40.0), 1.0, 40.0);
		const double Misty = FMath::Clamp(L.Mist * 2.0, 0.0, 1.0);
		Haze->SetFogDensity(static_cast<float>(FogDensity * Thicker));
		Haze->SetFogHeightFalloff(static_cast<float>(FMath::Lerp(static_cast<double>(FogFalloff), 0.02, Misty)));
		Haze->SetStartDistance(static_cast<float>(FMath::Lerp(static_cast<double>(FogStart), FogNearM * 100.0, Misty)));
		Haze->SetFogInscatteringColor(FLinearColor(L.FogColour.R, L.FogColour.G, L.FogColour.B) * static_cast<float>(0.9 * L.Mist));
		// A fog lies where the player is, on a hill as by the sea.
		FVector At = Haze->GetComponentLocation();
		At.Z = FMath::Lerp(0.0, GetActorLocation().Z, Misty);
		Haze->SetWorldLocation(At);
	}
}

void AEarthSky::SetFall(const TArray<FTransform>& Rain, const TArray<FTransform>& Snow, const TArray<FTransform>& Leaves, const FLinearColor& RainColour, const FLinearColor& SnowColour, const FLinearColor& LeafColour)
{
	const auto Show = [this](UInstancedStaticMeshComponent* Shapes, TObjectPtr<UMaterialInstanceDynamic>& Paint2, const TArray<FTransform>& Where, int32& Shown, const FLinearColor& Colour, float Opacity)
	{
		if (!Shapes)
		{
			return;
		}
		if (!Paint2)
		{
			UMaterialInterface* Material = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/EarthWalk/Materials/M_EarthFall.M_EarthFall"));
			if (!Material)
			{
				return; // not built yet (game\Tools\build-assets.cmd): nothing falls
			}
			Paint2 = UMaterialInstanceDynamic::Create(Material, this);
			Paint2->SetScalarParameterValue(TEXT("Opacity"), Opacity);
			Shapes->SetMaterial(0, Paint2);
		}
		if (Where.Num() != Shown)
		{
			Shapes->ClearInstances();
			if (Where.Num() > 0)
			{
				Shapes->AddInstances(Where, false, true);
			}
			Shown = Where.Num();
		}
		else if (Shown > 0)
		{
			Shapes->BatchUpdateInstancesTransforms(0, Where, true, true, false);
		}
		if (Shown > 0)
		{
			Paint2->SetVectorParameterValue(TEXT("Color"), Colour);
		}
	};
	Show(RainShapes, RainPaint, Rain, RainShown, RainColour, 0.8f);
	Show(SnowShapes, SnowPaint, Snow, SnowShown, SnowColour, 0.95f);
	Show(LeafShapes, LeafPaint, Leaves, LeavesShown, LeafColour, 1.f);
}

AEarthSky* AEarthSky::Make(UWorld* World, const FVector& SunTravels)
{
	UMaterialInterface* Material = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/EarthWalk/Materials/M_EarthSky.M_EarthSky"));
	AEarthSky* Sky = Material ? World->SpawnActor<AEarthSky>() : nullptr;
	if (!Sky)
	{
		return nullptr;
	}
	Sky->Paint = UMaterialInstanceDynamic::Create(Material, Sky);
	const FVector ToSun = -SunTravels.GetSafeNormal();
	Sky->Paint->SetVectorParameterValue(TEXT("Sun"), FLinearColor(ToSun.X, ToSun.Y, ToSun.Z));
	Sky->ApplyLook(); // and -EWSky=Name:value,... on top
	Sky->Dome->SetMaterial(0, Sky->Paint);
	return Sky;
}

void AEarthSky::ApplyLook()
{
	EarthLook::TuneSky(Paint);
}

void AEarthSky::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const APlayerController* Controller = GetWorld()->GetFirstPlayerController();
	if (Controller && Controller->PlayerCameraManager)
	{
		SetActorLocation(Controller->PlayerCameraManager->GetCameraLocation());
	}
}
