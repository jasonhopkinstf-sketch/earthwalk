#include "EarthSky.h"

#include "Camera/PlayerCameraManager.h"
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

	FString Tries;
	if (FParse::Value(FCommandLine::Get(), TEXT("-EWSky="), Tries, /*bShouldStopOnSeparator*/ false))
	{
		TArray<FString> Parts;
		Tries.ParseIntoArray(Parts, TEXT(","));
		for (const FString& Part : Parts)
		{
			FString Name, Value;
			if (Part.Split(TEXT(":"), &Name, &Value))
			{
				Sky->Paint->SetScalarParameterValue(FName(*Name.TrimStartAndEnd()), FCString::Atof(*Value));
			}
		}
	}
	Sky->Dome->SetMaterial(0, Sky->Paint);
	return Sky;
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
