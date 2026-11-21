#include "EarthGroundCover.h"

#include "EarthWorld.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "Math/RandomStream.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr double SquareCm = 1600.0; // a square of ground is 16 m across
	constexpr int32 Reach = 3; // squares planted in every direction from the player's own: about 55 m
	constexpr int32 PlantedPerUpdate = 6;
	constexpr int32 TuftsPerSquare = 44;
	constexpr int32 FlowerPatchesPerSquare = 5;
	constexpr int32 StonesPerSquare = 2;

	constexpr uint32 TuftColor = 0x4aa538ff;
	constexpr uint32 StemColor = 0x3f8f3aff;
	constexpr uint32 StoneColor = 0xb9b4a8ff;
	// One colour to a square, so flowers come in patches of a kind as they do in a field.
	constexpr uint32 PetalColors[] = { 0xe2392fff, 0xf7d038ff, 0xf7f5eeff, 0xf08fb8ff, 0x9b6fd6ff, 0x5b8fe8ff };
}

AEarthGroundCover::AEarthGroundCover()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cone(TEXT("/Engine/BasicShapes/Cone.Cone"));
	CylinderMesh = Cylinder.Object;
	SphereMesh = Sphere.Object;
	ConeMesh = Cone.Object;
}

void AEarthGroundCover::Clear()
{
	for (const TPair<FIntPoint, FParts>& Pair : Squares)
	{
		for (const TWeakObjectPtr<UInstancedStaticMeshComponent>& Part : Pair.Value)
		{
			if (Part.IsValid())
			{
				Part->DestroyComponent();
			}
		}
	}
	Squares.Reset();
}

void AEarthGroundCover::Update(AEarthWorld* World, const FVector& Around)
{
	if (!World)
	{
		return;
	}
	const FIntPoint Here(FMath::FloorToInt32(Around.X / SquareCm), FMath::FloorToInt32(Around.Y / SquareCm));

	// Clear squares well behind, with a square's margin so walking to and fro does not replant.
	for (auto It = Squares.CreateIterator(); It; ++It)
	{
		const FIntPoint Away = It.Key() - Here;
		if (FMath::Max(FMath::Abs(Away.X), FMath::Abs(Away.Y)) > Reach + 1)
		{
			for (const TWeakObjectPtr<UInstancedStaticMeshComponent>& Part : It.Value())
			{
				if (Part.IsValid())
				{
					Part->DestroyComponent();
				}
			}
			It.RemoveCurrent();
		}
	}

	// Plant the nearest unplanted squares first.
	int32 Planted = 0;
	for (int32 Ring = 0; Ring <= Reach && Planted < PlantedPerUpdate; ++Ring)
	{
		for (int32 DX = -Ring; DX <= Ring && Planted < PlantedPerUpdate; ++DX)
		{
			for (int32 DY = -Ring; DY <= Ring && Planted < PlantedPerUpdate; ++DY)
			{
				if (FMath::Max(FMath::Abs(DX), FMath::Abs(DY)) != Ring)
				{
					continue;
				}
				const FIntPoint Square(Here.X + DX, Here.Y + DY);
				if (Squares.Contains(Square))
				{
					continue;
				}
				FParts Parts;
				if (Plant(World, Square, Around.Z, Parts))
				{
					Squares.Add(Square, MoveTemp(Parts));
					++Planted;
				}
			}
		}
	}
}

UInstancedStaticMeshComponent* AEarthGroundCover::AddPart(FParts& Parts, UStaticMesh* Mesh, UMaterialInterface* Material)
{
	UInstancedStaticMeshComponent* Part = NewObject<UInstancedStaticMeshComponent>(this);
	Part->SetStaticMesh(Mesh);
	if (Material)
	{
		Part->SetMaterial(0, Material);
	}
	Part->SetMobility(EComponentMobility::Movable);
	Part->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Part->SetCastShadow(false); // thousands of tiny shadows would cost a lot and add little
	Part->SetupAttachment(RootComponent);
	Part->RegisterComponent();
	Parts.Add(Part);
	return Part;
}

bool AEarthGroundCover::Plant(AEarthWorld* World, FIntPoint Square, double AroundZ, FParts& Parts)
{
	const FVector2D Corner(Square.X * SquareCm, Square.Y * SquareCm);

	// The ground under a spot, or false where there is none to stand on (or a tree or a person is in the way).
	const auto Ground = [this, World, AroundZ](const FVector2D& At, FVector& Out)
	{
		FHitResult Hit;
		const FCollisionQueryParams Params(FName(TEXT("EarthWalkCover")), /*bTraceComplex*/ true);
		const FVector Top(At.X, At.Y, AroundZ + 30000.0);
		if (!GetWorld()->LineTraceSingleByChannel(Hit, Top, Top - FVector(0, 0, 90000.0), ECC_Visibility, Params) || Hit.GetActor() != World)
		{
			return false;
		}
		Out = Hit.ImpactPoint;
		return true;
	};

	// Nothing is planted until the whole square has ground that can be found, or it would stay half bare.
	for (const FVector2D& Probe : { FVector2D(0.02, 0.02), FVector2D(0.98, 0.02), FVector2D(0.02, 0.98), FVector2D(0.98, 0.98), FVector2D(0.5, 0.5) })
	{
		FVector Unused;
		const FVector2D At = Corner + Probe * SquareCm;
		if (World->CoverAt(FVector(At.X, At.Y, 0.0)) == EarthCover::Unknown || !Ground(At, Unused))
		{
			return false;
		}
	}

	FRandomStream Random(HashCombine(GetTypeHash(Square.X), GetTypeHash(Square.Y)));
	const auto Spot = [&Random, &Corner]()
	{
		return Corner + FVector2D(Random.FRand(), Random.FRand()) * SquareCm;
	};

	UInstancedStaticMeshComponent* Tufts = nullptr;
	for (int32 i = 0; i < TuftsPerSquare; ++i)
	{
		const FVector2D At = Spot();
		const float Size = Random.FRandRange(0.75f, 1.35f);
		const float Turn = Random.FRandRange(0.f, 360.f);
		FVector Base;
		if (World->CoverAt(FVector(At.X, At.Y, 0.0)) != EarthCover::Grass || !Ground(At, Base))
		{
			continue;
		}
		if (!Tufts)
		{
			Tufts = AddPart(Parts, ConeMesh, World->MaterialForFoliage(TuftColor, 0.f));
		}
		// A tuft: one blade upright and two leaning out from it. The engine cone is 100 cm wide and tall.
		const FRotator Spin(0.0, Turn, 0.0);
		Tufts->AddInstance(FTransform(Spin, Base + FVector(0, 0, 15.0 * Size), FVector(0.13, 0.13, 0.34) * Size), true);
		for (const float Side : { -1.f, 1.f })
		{
			const FRotator Lean(Side * 24.0, Turn + 25.0 * Side, 0.0);
			Tufts->AddInstance(FTransform(Lean, Base + Spin.RotateVector(FVector(Side * 7.0 * Size, 0, 11.0 * Size)), FVector(0.1, 0.1, 0.26) * Size), true);
		}
	}

	UInstancedStaticMeshComponent* Stems = nullptr;
	UInstancedStaticMeshComponent* Blooms = nullptr;
	const uint32 Petal = PetalColors[Random.RandRange(0, UE_ARRAY_COUNT(PetalColors) - 1)];
	for (int32 Patch = 0; Patch < FlowerPatchesPerSquare; ++Patch)
	{
		const FVector2D Middle = Spot();
		const int32 Heads = Random.RandRange(4, 9);
		for (int32 i = 0; i < Heads; ++i)
		{
			const FVector2D At = Middle + FVector2D(Random.FRandRange(-70.f, 70.f), Random.FRandRange(-70.f, 70.f));
			const float Tall = Random.FRandRange(18.f, 34.f);
			FVector Base;
			const uint8 Cover = World->CoverAt(FVector(At.X, At.Y, 0.0));
			if ((Cover != EarthCover::Grass && Cover != EarthCover::Forest) || !Ground(At, Base))
			{
				continue;
			}
			if (!Stems)
			{
				Stems = AddPart(Parts, CylinderMesh, World->MaterialForFoliage(StemColor, 0.f));
				Blooms = AddPart(Parts, SphereMesh, World->MaterialForFoliage(Petal, 0.f));
			}
			Stems->AddInstance(FTransform(FRotator::ZeroRotator, Base + FVector(0, 0, Tall * 0.5), FVector(0.022, 0.022, Tall / 100.0)), true);
			Blooms->AddInstance(FTransform(FRotator::ZeroRotator, Base + FVector(0, 0, Tall), FVector(0.15, 0.15, 0.1)), true);
		}
	}

	UInstancedStaticMeshComponent* Stones = nullptr;
	for (int32 i = 0; i < StonesPerSquare; ++i)
	{
		const FVector2D At = Spot();
		const float Size = Random.FRandRange(0.6f, 1.5f);
		const float Turn = Random.FRandRange(0.f, 360.f);
		FVector Base;
		if (World->CoverAt(FVector(At.X, At.Y, 0.0)) != EarthCover::Grass || !Ground(At, Base))
		{
			continue;
		}
		if (!Stones)
		{
			Stones = AddPart(Parts, SphereMesh, World->MaterialForFoliage(StoneColor, 0.f));
		}
		Stones->AddInstance(FTransform(FRotator(0.0, Turn, 0.0), Base + FVector(0, 0, 3.0 * Size), FVector(0.22, 0.16, 0.1) * Size), true);
	}
	return true;
}
