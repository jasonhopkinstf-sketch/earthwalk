#include "EarthRaceCourse.h"

#include "EarthWalkNet.h"
#include "EarthWorld.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr double GatePostM = 3.6;  // how tall a gate is
	constexpr double GateHalfM = 3.6;  // a gate spans a road
	constexpr int32 SquaresAcross = 12;
	// Posts and pale squares, start, gate, finish, and the two greys of a gate passed.
	const uint32 GatePaints[] = { 0xf4f1ea, 0x3f9a45, 0xf08a3c, 0x26262b, 0x9aa6b2, 0xc9ced4 };
	enum { PaintPale = 0, PaintStart = 1, PaintGate = 2, PaintFinish = 3, PaintPassed = 4, PaintPassedPale = 5 };
}

AEarthRaceCourse::AEarthRaceCourse()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	CubeMesh = Cube.Object;
	CylinderMesh = Cylinder.Object;
}

int32 AEarthRaceCourse::Rebuild(AEarthWorld* World, const FEarthRace& Race, int32 MyGate, bool bBeacon)
{
	if (!World)
	{
		return 0;
	}
	if (Paints.Num() == 0)
	{
		for (const uint32 Hex : GatePaints)
		{
			UInstancedStaticMeshComponent* Paint = NewObject<UInstancedStaticMeshComponent>(this);
			Paint->SetStaticMesh(CubeMesh);
			Paint->SetMaterial(0, World->MaterialFor((Hex << 8) | 0xff));
			Paint->SetMobility(EComponentMobility::Movable);
			Paint->SetCollisionEnabled(ECollisionEnabled::NoCollision); // a gate is driven through, not into
			Paint->SetupAttachment(RootComponent);
			Paint->RegisterComponent();
			Paints.Add(Paint);
		}
		Beacon = NewObject<UStaticMeshComponent>(this);
		Beacon->SetStaticMesh(CylinderMesh);
		Beacon->SetMaterial(0, World->MaterialFor(0xffd84aff));
		Beacon->SetMobility(EComponentMobility::Movable);
		Beacon->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Beacon->SetupAttachment(RootComponent);
		Beacon->RegisterComponent();
	}
	for (UInstancedStaticMeshComponent* Paint : Paints)
	{
		Paint->ClearInstances();
	}
	Beacon->SetVisibility(false);

	const int32 Count = Race.Gates.Num();
	int32 Placed = 0;
	for (int32 i = 0; i < Count; ++i)
	{
		// On the ground, across the road: its banner faces along the course, from the gate before to the gate after.
		FVector At = World->GeoToWorld(Race.Gates[i].X, Race.Gates[i].Y, 0.0);
		double Ground = 0.0;
		if (!World->TerrainHeightAt(At.Y / 100.0, -At.X / 100.0, Ground))
		{
			continue;
		}
		At.Z = Ground * 100.0;
		const FVector2D Before = Race.Gates[FMath::Max(0, i - 1)], After = Race.Gates[FMath::Min(Count - 1, i + 1)];
		const FVector Along = (World->GeoToWorld(After.X, After.Y, 0.0) - World->GeoToWorld(Before.X, Before.Y, 0.0)).GetSafeNormal2D();
		const FRotator Facing(0.0, Along.IsNearlyZero() ? 0.0 : Along.Rotation().Yaw, 0.0);
		const FVector Across = FRotationMatrix(Facing).GetUnitAxis(EAxis::Y);
		++Placed;

		// An agility course: a small thing to run at, built to face along the course (makeObstacle in race.js).
		if (Race.Kind == TEXT("agility"))
		{
			const FString What = Race.Obstacles.IsValidIndex(i) ? Race.Obstacles[i] : FString(TEXT("jump"));
			const bool bPassed = MyGate >= 0 && i < MyGate;
			const int32 Bold = bPassed ? PaintPassed : What == TEXT("start") ? PaintStart : What == TEXT("finish") ? PaintFinish : PaintGate;
			const int32 Light = bPassed ? PaintPassedPale : PaintPale;
			const FVector Forward = FRotationMatrix(Facing).GetUnitAxis(EAxis::X);
			// A box so many metres along, across and up, its middle so far along, across and above the ground.
			const auto Part = [&](int32 Paint, double AlongM, double AcrossM, double UpM, double SizeAlong, double SizeAcross, double SizeUp)
			{
				Paints[Paint]->AddInstance(FTransform(Facing, At + Forward * AlongM * 100.0 + Across * AcrossM * 100.0 + FVector(0, 0, UpM * 100.0), FVector(SizeAlong, SizeAcross, SizeUp)), true);
			};
			if (What == TEXT("start") || What == TEXT("finish"))
			{
				Part(Light, 0.0, -1.3, 0.9, 0.14, 0.14, 1.8);
				Part(Light, 0.0, 1.3, 0.9, 0.14, 0.14, 1.8);
				Part(Bold, 0.0, 0.0, 1.65, 0.1, 2.6, 0.3);
			}
			else if (What == TEXT("hoop"))
			{
				Part(Light, 0.0, 0.0, 0.2, 0.12, 0.12, 0.4);
				Part(Bold, 0.0, -0.8, 1.2, 0.1, 0.1, 1.7);
				Part(Bold, 0.0, 0.8, 1.2, 0.1, 0.1, 1.7);
				Part(Bold, 0.0, 0.0, 0.4, 0.1, 1.6, 0.1);
				Part(Bold, 0.0, 0.0, 2.0, 0.1, 1.6, 0.1);
			}
			else if (What == TEXT("weave"))
			{
				for (int32 k = 0; k < 5; ++k)
				{
					Part(k % 2 ? Light : Bold, (k - 2) * 0.9, 0.0, 0.6, 0.1, 0.1, 1.2);
				}
			}
			else if (What == TEXT("tunnel"))
			{
				Part(Bold, 0.0, -0.6, 0.5, 2.2, 0.08, 1.0);
				Part(Bold, 0.0, 0.6, 0.5, 2.2, 0.08, 1.0);
				Part(Light, 0.0, 0.0, 1.04, 2.2, 1.28, 0.08);
			}
			else if (What == TEXT("table"))
			{
				Part(Bold, 0.0, 0.0, 0.42, 1.4, 1.4, 0.12);
				for (const double Lx : { -0.6, 0.6 })
				{
					for (const double Ly : { -0.6, 0.6 })
					{
						Part(Light, Lx, Ly, 0.18, 0.1, 0.1, 0.36);
					}
				}
			}
			else
			{
				// A jump: a bar across two short posts.
				Part(Light, 0.0, -0.95, 0.45, 0.12, 0.12, 0.9);
				Part(Light, 0.0, 0.95, 0.45, 0.12, 0.12, 0.9);
				Part(Bold, 0.0, 0.0, 0.55, 0.08, 1.9, 0.08);
			}
			if (bBeacon && i == MyGate)
			{
				Beacon->SetWorldLocation(At + FVector(0, 0, 900.0));
				Beacon->SetWorldScale3D(FVector(0.18, 0.18, 12.0));
				Beacon->SetVisibility(true);
			}
			continue;
		}

		const bool bStart = i == 0, bFinish = i == Count - 1;
		// Gates I have been through go grey (the finish keeps its chequers).
		const bool bDone = MyGate >= 0 && i < MyGate && !bFinish;
		const int32 Colour = bDone ? PaintPassed : bStart ? PaintStart : bFinish ? PaintFinish : PaintGate;
		const int32 Pale = bDone ? PaintPassedPale : PaintPale;
		for (const double Side : { -1.0, 1.0 })
		{
			Paints[PaintPale]->AddInstance(FTransform(Facing, At + Across * Side * GateHalfM * 100.0 + FVector(0, 0, GatePostM * 50.0), FVector(0.22, 0.22, GatePostM)), /*bWorldSpace*/ true);
		}
		const int32 Down = bStart || bFinish ? 2 : 1;
		const double Size = (GateHalfM * 2.0) / SquaresAcross;
		for (int32 a = 0; a < SquaresAcross; ++a)
		{
			for (int32 d = 0; d < Down; ++d)
			{
				const FVector Where = At + Across * (-GateHalfM + Size * (a + 0.5)) * 100.0 + FVector(0, 0, (GatePostM - Size * (d + 0.5)) * 100.0);
				Paints[(a + d) % 2 == 0 ? Colour : Pale]->AddInstance(FTransform(Facing, Where, FVector(0.1, Size, Size)), true);
			}
		}
		// A beacon over the gate I am to go through next: a tall thin column, seen from streets away.
		if (bBeacon && i == MyGate)
		{
			Beacon->SetWorldLocation(At + FVector(0, 0, (GatePostM + 30.0) * 100.0));
			Beacon->SetWorldScale3D(FVector(0.5, 0.5, 60.0));
			Beacon->SetVisibility(true);
		}
	}
	return Placed;
}
