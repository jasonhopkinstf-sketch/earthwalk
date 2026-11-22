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
