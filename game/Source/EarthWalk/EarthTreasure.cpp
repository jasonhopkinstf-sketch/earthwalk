#include "EarthTreasure.h"

#include "EarthWorld.h"
#include "Components/SceneComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr float TreasureShownSeconds = 60.f;

	/** The browser's chest: x to its right, y up, z behind it (the lock is at the front), metres. Here: X to the front, Y right, Z up, centimetres. */
	FVector ChestToEngine(const FVector& P)
	{
		return FVector(-P.Z, P.X, P.Y) * 100.0;
	}
}

AEarthTreasure::AEarthTreasure()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	CubeMesh = Cube.Object;
	CylinderMesh = Cylinder.Object;
	InitialLifeSpan = TreasureShownSeconds;
}

UStaticMeshComponent* AEarthTreasure::AddPart(USceneComponent* Parent, bool bCoin, uint32 Hex, const FVector& Scale, const FVector& Position, AEarthWorld* World)
{
	UStaticMeshComponent* Part = NewObject<UStaticMeshComponent>(this);
	Part->SetStaticMesh(bCoin ? CylinderMesh : CubeMesh);
	if (World)
	{
		Part->SetMaterial(0, World->MaterialFor((Hex << 8) | 0xff));
	}
	Part->SetMobility(EComponentMobility::Movable);
	Part->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Part->SetupAttachment(Parent);
	Part->SetRelativeLocation(ChestToEngine(Position));
	// Engine cubes and cylinders are a metre a side; the browser gives each box its size in metres.
	Part->SetRelativeScale3D(FVector(Scale.Z, Scale.X, Scale.Y));
	Part->RegisterComponent();
	return Part;
}

void AEarthTreasure::Build(AEarthWorld* World)
{
	constexpr uint32 Wood = 0x8a5a3a, Band = 0xd0a21e, Gold = 0xf2cc4a;
	AddPart(RootComponent, false, Wood, FVector(0.9, 0.5, 0.6), FVector(0, 0.25, 0), World);
	for (const double X : { -0.3, 0.3 })
	{
		AddPart(RootComponent, false, Band, FVector(0.08, 0.52, 0.62), FVector(X, 0.25, 0), World);
	}
	AddPart(RootComponent, false, Band, FVector(0.16, 0.16, 0.04), FVector(0, 0.34, -0.31), World); // the lock

	// The lid is hinged along the back edge and thrown open past upright.
	USceneComponent* Lid = NewObject<USceneComponent>(this);
	Lid->SetMobility(EComponentMobility::Movable);
	Lid->SetupAttachment(RootComponent);
	Lid->SetRelativeLocation(ChestToEngine(FVector(0, 0.5, 0.3)));
	Lid->SetRelativeRotation(FQuat(FVector::YAxisVector, -1.9)); // a turn about the browser's x, which is the engine's Y the other way
	Lid->RegisterComponent();
	AddPart(Lid, false, Wood, FVector(0.9, 0.16, 0.6), FVector(0, 0.08, -0.3), World);
	for (const double X : { -0.3, 0.3 })
	{
		AddPart(Lid, false, Band, FVector(0.08, 0.18, 0.62), FVector(X, 0.08, -0.3), World);
	}

	AddPart(RootComponent, false, Gold, FVector(0.8, 0.12, 0.5), FVector(0, 0.48, 0), World); // a heap of gold to the brim
	for (int32 i = 0; i < 7; ++i)
	{
		// A coin: 18 cm across and thin, standing on its edge.
		Coins.Add(AddPart(RootComponent, true, Gold, FVector(0.18, 0.025, 0.18), FVector(((i * 37) % 60) / 100.0 - 0.3, 0.8 + (i % 3) * 0.22, ((i * 53) % 40) / 100.0 - 0.2), World));
	}
}

void AEarthTreasure::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	Age += DeltaSeconds;
	for (int32 i = 0; i < Coins.Num(); ++i)
	{
		if (UStaticMeshComponent* Coin = Coins[i])
		{
			// Tipped onto its edge, then turning about the upright, and bobbing.
			Coin->SetRelativeRotation(FQuat(FVector::ZAxisVector, -(Age * 3.f + i)) * FQuat(FVector::XAxisVector, UE_DOUBLE_PI / 2.0));
			FVector At = Coin->GetRelativeLocation();
			At.Z = (0.8 + (i % 3) * 0.22 + FMath::Sin(Age * 2.f + i) * 0.08) * 100.0;
			Coin->SetRelativeLocation(At);
		}
	}
	// It shrinks away in its last second.
	const float Left = TreasureShownSeconds - Age;
	if (Left < 1.f)
	{
		SetActorScale3D(FVector(FMath::Max(0.01f, Left)));
	}
}
