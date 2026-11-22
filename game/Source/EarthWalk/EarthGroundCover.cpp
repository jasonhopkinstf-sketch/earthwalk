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
	constexpr int32 PlantReach = 3; // squares planted in every direction from the player's own: about 55 m
	constexpr int32 PlantedPerUpdate = 6;
	constexpr int32 TuftsPerSquare = 44;
	constexpr int32 FlowerPatchesPerSquare = 5;
	constexpr int32 StonesPerSquare = 2;
	constexpr int32 Lattice = 5; // ground heights are measured on a 5 x 5 grid of each square, 4 m apart

	constexpr uint32 TuftColor = 0x4aa538ff;
	constexpr uint32 StemColor = 0x3f8f3aff;
	constexpr uint32 StoneColor = 0xb9b4a8ff;
	constexpr uint32 BushColor = 0x3f9a45ff;
	constexpr uint32 WoodBushColor = 0x2f7f3cff;
	constexpr uint32 WheatColor = 0xe9c94fff;
	constexpr uint32 CabbageColor = 0x77bb6aff;
	constexpr uint32 CornColor = 0x4f9f3fff;
	constexpr uint32 StrawColor = 0xe2c36aff;
	// One colour to a square, so flowers come in patches of a kind as they do in a field.
	constexpr uint32 PetalColors[] = { 0xe2392fff, 0xf7d038ff, 0xf7f5eeff, 0xf08fb8ff, 0x9b6fd6ff, 0x5b8fe8ff };

	// Rows of crops stand on the ridges between the furrows M_EarthTop draws on farmland
	// (EarthWalkAssetsCommandlet.cpp, TopCode): furrows run across this direction, 1.8 m apart.
	const FVector2D AcrossRows(0.8, 0.6);
	const FVector2D AlongRows(-0.6, 0.8);
	constexpr double RowGapM = 1.8;
	constexpr double FieldCm = 12000.0; // one crop to a field about this size
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

void AEarthGroundCover::Replant(const FVector2D& Centre, double Radius)
{
	for (auto It = Squares.CreateIterator(); It; ++It)
	{
		const FVector2D Corner(It.Key().X * SquareCm, It.Key().Y * SquareCm);
		if (Centre.X > Corner.X - Radius && Centre.X < Corner.X + SquareCm + Radius && Centre.Y > Corner.Y - Radius && Centre.Y < Corner.Y + SquareCm + Radius)
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
		if (FMath::Max(FMath::Abs(Away.X), FMath::Abs(Away.Y)) > PlantReach + 1)
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
	for (int32 Ring = 0; Ring <= PlantReach && Planted < PlantedPerUpdate; ++Ring)
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
	const auto CoverOf = [World](const FVector2D& At)
	{
		return World->CoverAt(FVector(At.X, At.Y, 0.0));
	};

	// The ground under a spot by looking for it, or false where there is none (or a tree or a person is in the way).
	const auto Probe = [this, World, AroundZ](const FVector2D& At, double& OutZ)
	{
		FHitResult Hit;
		const FCollisionQueryParams Params(FName(TEXT("EarthWalkCover")), /*bTraceComplex*/ true);
		const FVector Top(At.X, At.Y, AroundZ + 30000.0);
		if (!GetWorld()->LineTraceSingleByChannel(Hit, Top, Top - FVector(0, 0, 90000.0), ECC_Visibility, Params) || Hit.GetActor() != World)
		{
			return false;
		}
		OutZ = Hit.ImpactPoint.Z;
		return true;
	};

	// Heights on a grid of the square. A point with open ground at all four grid points round it takes
	// its height from them, which saves looking for the ground under every blade; near a house or a
	// road, where a grid point may be on a roof, it is looked for directly.
	double Heights[Lattice][Lattice];
	bool bOpen[Lattice][Lattice];
	const double Step = SquareCm / (Lattice - 1);
	for (int32 J = 0; J < Lattice; ++J)
	{
		for (int32 I = 0; I < Lattice; ++I)
		{
			const FVector2D At = Corner + FVector2D(I, J) * Step;
			const uint8 Cover = CoverOf(At);
			if (Cover == EarthCover::Unknown)
			{
				return false; // the chunk has not arrived: try this square again later
			}
			const bool bFound = Probe(At, Heights[J][I]);
			if (!bFound && (I == 0 || I == Lattice - 1) && (J == 0 || J == Lattice - 1))
			{
				return false; // a corner with no ground to find yet (collision still being prepared)
			}
			bOpen[J][I] = bFound && Cover != EarthCover::Blocked;
		}
	}
	const auto Ground = [&](const FVector2D& At, FVector& Out)
	{
		const FVector2D In = (At - Corner) / Step;
		const int32 I = FMath::Clamp(FMath::FloorToInt32(In.X), 0, Lattice - 2);
		const int32 J = FMath::Clamp(FMath::FloorToInt32(In.Y), 0, Lattice - 2);
		double Z = 0.0;
		if (bOpen[J][I] && bOpen[J][I + 1] && bOpen[J + 1][I] && bOpen[J + 1][I + 1])
		{
			const double Fx = FMath::Clamp(In.X - I, 0.0, 1.0), Fy = FMath::Clamp(In.Y - J, 0.0, 1.0);
			Z = FMath::Lerp(FMath::Lerp(Heights[J][I], Heights[J][I + 1], Fx), FMath::Lerp(Heights[J + 1][I], Heights[J + 1][I + 1], Fx), Fy);
		}
		else if (!Probe(At, Z))
		{
			return false;
		}
		Out = FVector(At.X, At.Y, Z);
		return true;
	};

	FRandomStream Random(HashCombine(GetTypeHash(Square.X), GetTypeHash(Square.Y)));
	const auto Spot = [&Random, &Corner]()
	{
		return Corner + FVector2D(Random.FRand(), Random.FRand()) * SquareCm;
	};

	// ---- grass: tufts
	UInstancedStaticMeshComponent* Tufts = nullptr;
	for (int32 i = 0; i < TuftsPerSquare; ++i)
	{
		const FVector2D At = Spot();
		const float Size = Random.FRandRange(0.75f, 1.35f);
		const float Turn = Random.FRandRange(0.f, 360.f);
		FVector Base;
		if (CoverOf(At) != EarthCover::Grass || !Ground(At, Base))
		{
			continue;
		}
		if (!Tufts)
		{
			Tufts = AddPart(Parts, ConeMesh, World->MaterialForFoliage(TuftColor, 0.f, 4, true));
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

	// ---- grass and woods: patches of flowers
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
			const uint8 Cover = CoverOf(At);
			if ((Cover != EarthCover::Grass && Cover != EarthCover::Forest) || !Ground(At, Base))
			{
				continue;
			}
			if (!Stems)
			{
				Stems = AddPart(Parts, CylinderMesh, World->MaterialForFoliage(StemColor, 0.f, 5, true));
				Blooms = AddPart(Parts, SphereMesh, World->MaterialForFoliage(Petal, 0.f, 5, true));
			}
			Stems->AddInstance(FTransform(FRotator::ZeroRotator, Base + FVector(0, 0, Tall * 0.5), FVector(0.022, 0.022, Tall / 100.0)), true);
			Blooms->AddInstance(FTransform(FRotator::ZeroRotator, Base + FVector(0, 0, Tall), FVector(0.15, 0.15, 0.1)), true);
		}
	}

	// ---- bushes: one here and there on grass, several to a square under trees
	UInstancedStaticMeshComponent* Bushes = nullptr;
	UInstancedStaticMeshComponent* WoodBushes = nullptr;
	for (int32 i = 0; i < 5; ++i)
	{
		const FVector2D At = Spot();
		const float Size = Random.FRandRange(0.7f, 1.3f);
		const float Turn = Random.FRandRange(0.f, 360.f);
		const bool bLucky = Random.FRand() < 0.2f;
		FVector Base;
		const uint8 Cover = CoverOf(At);
		if ((Cover != EarthCover::Forest && !(Cover == EarthCover::Grass && bLucky)) || !Ground(At, Base))
		{
			continue;
		}
		UInstancedStaticMeshComponent*& Part = Cover == EarthCover::Forest ? WoodBushes : Bushes;
		if (!Part)
		{
			Part = AddPart(Parts, SphereMesh, World->MaterialForFoliage(Cover == EarthCover::Forest ? WoodBushColor : BushColor, 1.f, 3));
		}
		// A bush: three blobs in a clump, the middle one tallest.
		const FRotator Spin(0.0, Turn, 0.0);
		Part->AddInstance(FTransform(Spin, Base + FVector(0, 0, 38.0 * Size), FVector(1.0, 1.0, 0.85) * Size), true);
		Part->AddInstance(FTransform(Spin, Base + Spin.RotateVector(FVector(42.0, 10.0, 26.0) * Size), FVector(0.72) * Size), true);
		Part->AddInstance(FTransform(Spin, Base + Spin.RotateVector(FVector(-36.0, -22.0, 24.0) * Size), FVector(0.66) * Size), true);
	}

	// ---- grass: the odd stone
	UInstancedStaticMeshComponent* Stones = nullptr;
	for (int32 i = 0; i < StonesPerSquare; ++i)
	{
		const FVector2D At = Spot();
		const float Size = Random.FRandRange(0.6f, 1.5f);
		const float Turn = Random.FRandRange(0.f, 360.f);
		FVector Base;
		if (CoverOf(At) != EarthCover::Grass || !Ground(At, Base))
		{
			continue;
		}
		if (!Stones)
		{
			Stones = AddPart(Parts, SphereMesh, World->MaterialForFoliage(StoneColor, 0.f, 0, true));
		}
		Stones->AddInstance(FTransform(FRotator(0.0, Turn, 0.0), Base + FVector(0, 0, 3.0 * Size), FVector(0.22, 0.16, 0.1) * Size), true);
	}

	// ---- farmland: rows of a crop on the ridges between the furrows, one crop to a field
	const FVector2D Middle = Corner + FVector2D(SquareCm, SquareCm) * 0.5;
	if (CoverOf(Middle) == EarthCover::Farm || CoverOf(Corner + FVector2D(SquareCm * 0.25, SquareCm * 0.25)) == EarthCover::Farm
		|| CoverOf(Corner + FVector2D(SquareCm * 0.75, SquareCm * 0.75)) == EarthCover::Farm)
	{
		const int32 Crop = HashCombine(GetTypeHash(FMath::FloorToInt32(Middle.X / FieldCm)), GetTypeHash(FMath::FloorToInt32(Middle.Y / FieldCm))) % 4;
		// 0 wheat, 1 cabbages, 2 maize, 3 lying fallow.
		const double Apart = Crop == 0 ? 0.6 : Crop == 1 ? 0.9 : 0.8; // metres between plants along a row
		UInstancedStaticMeshComponent* Plants = nullptr;
		// Nothing is sown where a herd roams or a tractor works (the living world's homes).
		TArray<FVector> Kept;
		World->HomeCirclesIn(FBox2D(Corner, Corner + FVector2D(SquareCm, SquareCm)), Kept);
		const auto KeptClear = [&Kept](const FVector2D& Where)
		{
			for (const FVector& Circle : Kept)
			{
				if (FMath::Square(Where.X - Circle.X) + FMath::Square(Where.Y - Circle.Y) < Circle.Z * Circle.Z)
				{
					return true;
				}
			}
			return false;
		};
		double MinAcross = TNumericLimits<double>::Max(), MaxAcross = -MinAcross, MinAlong = MinAcross, MaxAlong = -MinAcross;
		for (const FVector2D& Unit : { FVector2D(0, 0), FVector2D(1, 0), FVector2D(0, 1), FVector2D(1, 1) })
		{
			const FVector2D Metres = (Corner + Unit * SquareCm) / 100.0;
			MinAcross = FMath::Min(MinAcross, FVector2D::DotProduct(Metres, AcrossRows));
			MaxAcross = FMath::Max(MaxAcross, FVector2D::DotProduct(Metres, AcrossRows));
			MinAlong = FMath::Min(MinAlong, FVector2D::DotProduct(Metres, AlongRows));
			MaxAlong = FMath::Max(MaxAlong, FVector2D::DotProduct(Metres, AlongRows));
		}
		for (double Row = FMath::CeilToDouble(MinAcross / RowGapM - 0.6); Crop != 3 && (Row + 0.6) * RowGapM <= MaxAcross; Row += 1.0)
		{
			for (double Along = FMath::CeilToDouble(MinAlong / Apart) * Apart; Along <= MaxAlong; Along += Apart)
			{
				const FVector2D At = (AcrossRows * (Row + 0.6) * RowGapM + AlongRows * Along) * 100.0;
				if (At.X < Corner.X || At.X >= Corner.X + SquareCm || At.Y < Corner.Y || At.Y >= Corner.Y + SquareCm)
				{
					continue;
				}
				const float Size = Random.FRandRange(0.85f, 1.15f);
				FVector Base;
				if (CoverOf(At) != EarthCover::Farm || KeptClear(At) || !Ground(At, Base))
				{
					continue;
				}
				if (!Plants)
				{
					Plants = Crop == 1 ? AddPart(Parts, SphereMesh, World->MaterialForFoliage(CabbageColor, 1.f, 1, true))
						: AddPart(Parts, ConeMesh, World->MaterialForFoliage(Crop == 0 ? WheatColor : CornColor, 0.f, Crop == 0 ? 6 : 8, true));
				}
				const FVector SizeM = Crop == 0 ? FVector(0.16, 0.16, 0.6) : Crop == 1 ? FVector(0.42, 0.42, 0.28) : FVector(0.26, 0.26, 1.5);
				Plants->AddInstance(FTransform(FRotator::ZeroRotator, Base + FVector(0, 0, SizeM.Z * 50.0 * Size - 2.0), SizeM * Size), true);
			}
		}
		// In a wheat field, now and then a round bale of straw lying on its side.
		const FVector2D At = Spot();
		const float Turn = Random.FRandRange(0.f, 360.f);
		FVector Base;
		if (Crop == 0 && Random.FRand() < 0.3f && CoverOf(At) == EarthCover::Farm && !KeptClear(At) && Ground(At, Base))
		{
			UInstancedStaticMeshComponent* Bales = AddPart(Parts, CylinderMesh, World->MaterialForFoliage(StrawColor, 0.f));
			Bales->AddInstance(FTransform(FRotator(90.0, Turn, 0.0), Base + FVector(0, 0, 65.0), FVector(1.3, 1.3, 1.2)), true);
		}
	}
	return true;
}
