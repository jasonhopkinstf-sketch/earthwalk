#include "EarthChunkLabels.h"

#include "EarthWorld.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Components/TextRenderComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr uint32 PostColor = 0x6b6b6bff;
	constexpr uint32 LetterboxColor = 0xe8e4d8ff;
	constexpr uint32 PlateColor = 0x0f4d2aff;
	constexpr uint32 BarkColor = 0x5a3d2aff;
	constexpr uint32 LeafColor = 0x3f8a2fff;
	constexpr uint32 NeedleColor = 0x2f6b2fff;
	// Letterboxes are about three times life size, so the number reads from across the street.
	constexpr double LetterboxPostHeight = 150.0; // cm
	const FVector LetterboxSize(54.0, 90.0, 66.0); // depth (towards the street), width, height in cm
	constexpr float NumberSize = 46.f; // text height in cm
	constexpr float NameSize = 16.f;
}

AEarthChunkLabels::AEarthChunkLabels()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cone(TEXT("/Engine/BasicShapes/Cone.Cone"));
	CubeMesh = Cube.Object;
	CylinderMesh = Cylinder.Object;
	SphereMesh = Sphere.Object;
	ConeMesh = Cone.Object;
}

void AEarthChunkLabels::AddBox(const FVector& Location, const FRotator& Rotation, const FVector& SizeCm, UMaterialInterface* Material)
{
	UStaticMeshComponent* Box = NewObject<UStaticMeshComponent>(this);
	Box->SetStaticMesh(CubeMesh);
	if (Material)
	{
		Box->SetMaterial(0, Material);
	}
	Box->SetMobility(EComponentMobility::Movable);
	Box->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Box->SetupAttachment(RootComponent);
	Box->SetRelativeLocation(Location);
	Box->SetRelativeRotation(Rotation);
	Box->SetRelativeScale3D(SizeCm / 100.0); // the engine cube is 100 cm across
	Box->RegisterComponent();
}

void AEarthChunkLabels::AddText(const FString& Text, const FVector& Location, const FRotator& Rotation, float SizeCm, const FColor& Color)
{
	// Text render components read correctly from their +X side and use the engine's Roboto font by default.
	UTextRenderComponent* Label = NewObject<UTextRenderComponent>(this);
	Label->SetMobility(EComponentMobility::Movable);
	Label->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Label->SetupAttachment(RootComponent);
	Label->SetRelativeLocation(Location);
	Label->SetRelativeRotation(Rotation);
	Label->SetText(FText::FromString(Text));
	Label->SetWorldSize(SizeCm);
	Label->SetHorizontalAlignment(EHTA_Center);
	Label->SetVerticalAlignment(EVRTA_TextCenter);
	Label->SetTextRenderColor(Color);
	Label->RegisterComponent();
}

void AEarthChunkLabels::AddPlate(const FString& Text, const FVector& Location, double Yaw, AEarthWorld* World)
{
	const FRotator Facing(0.0, Yaw, 0.0);
	const FRotator Back(0.0, Yaw + 180.0, 0.0);
	const double Width = FMath::Clamp(Text.Len() * NameSize * 0.62 + 24.0, 60.0, 420.0);
	AddBox(Location, Facing, FVector(3.0, Width, 22.0), World->MaterialFor(PlateColor));
	AddText(Text, Location + Facing.RotateVector(FVector(2.0, 0, 0)), Facing, NameSize, FColor::White);
	AddText(Text, Location + Facing.RotateVector(FVector(-2.0, 0, 0)), Back, NameSize, FColor::White);
}

UInstancedStaticMeshComponent* AEarthChunkLabels::Instanced(TObjectPtr<UInstancedStaticMeshComponent>& Slot, UStaticMesh* Mesh, UMaterialInterface* Material, bool bCollide)
{
	if (!Slot)
	{
		UInstancedStaticMeshComponent* Component = NewObject<UInstancedStaticMeshComponent>(this);
		Component->SetStaticMesh(Mesh);
		if (Material)
		{
			Component->SetMaterial(0, Material);
		}
		Component->SetMobility(EComponentMobility::Movable);
		if (bCollide)
		{
			Component->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
			Component->SetCollisionObjectType(ECC_WorldStatic);
			Component->SetCollisionResponseToAllChannels(ECR_Block);
		}
		else
		{
			Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		}
		Component->SetupAttachment(RootComponent);
		Component->RegisterComponent();
		Slot = Component;
	}
	return Slot;
}

/** A tree from engine shapes: a trunk with either a cluster of leafy spheres or a conifer cone. Scales are in metres. */
void AEarthChunkLabels::AddTree(const FVector& Base, double Yaw, double HeightM, double RadiusM, bool bConifer, AEarthWorld* World)
{
	const FRotator Spin(0.0, Yaw, 0.0);
	const double TrunkH = HeightM * (bConifer ? 0.3 : 0.45);
	Instanced(Trunks, CylinderMesh, World->MaterialForFoliage(BarkColor, 0.f), true)
		->AddInstance(FTransform(Spin, Base + FVector(0, 0, TrunkH * 50.0), FVector(0.3, 0.3, TrunkH)), true);
	if (bConifer)
	{
		Instanced(Conifers, ConeMesh, World->MaterialForFoliage(NeedleColor, 1.f), false)
			->AddInstance(FTransform(Spin, Base + FVector(0, 0, HeightM * 60.0), FVector(RadiusM * 1.8, RadiusM * 1.8, HeightM * 0.8)), true);
	}
	else
	{
		UInstancedStaticMeshComponent* Leaves = Instanced(Canopies, SphereMesh, World->MaterialForFoliage(LeafColor, 1.f), false);
		// A rounded crown: one big sphere with three smaller ones tucked around and above it.
		const FVector Centre = Base + FVector(0, 0, HeightM * 65.0);
		Leaves->AddInstance(FTransform(Spin, Centre, FVector(RadiusM * 2.0, RadiusM * 2.0, RadiusM * 1.7)), true);
		Leaves->AddInstance(FTransform(Spin, Centre + Spin.RotateVector(FVector(RadiusM * 45.0, RadiusM * 25.0, RadiusM * 45.0)), FVector(RadiusM * 1.4)), true);
		Leaves->AddInstance(FTransform(Spin, Centre + Spin.RotateVector(FVector(-RadiusM * 50.0, -RadiusM * 30.0, RadiusM * 20.0)), FVector(RadiusM * 1.3)), true);
		Leaves->AddInstance(FTransform(Spin, Centre + Spin.RotateVector(FVector(RadiusM * 10.0, -RadiusM * 55.0, -RadiusM * 10.0)), FVector(RadiusM * 1.2)), true);
	}
	++Trees;
}

void AEarthChunkLabels::Build(const TArray<TSharedPtr<FJsonValue>>& Items, const FVector& ChunkOrigin, double TileCm, AEarthWorld* World)
{
	for (const TSharedPtr<FJsonValue>& Value : Items)
	{
		const TSharedPtr<FJsonObject>* Item = nullptr;
		if (!Value.IsValid() || !Value->TryGetObject(Item) || !Item || !Item->IsValid())
		{
			continue;
		}
		const FJsonObject& Json = **Item;
		FString Kind;
		double U = 0.0, V = 0.0, H = 0.0, Yaw = 0.0;
		if (!Json.TryGetStringField(TEXT("kind"), Kind) ||
			!Json.TryGetNumberField(TEXT("u"), U) || !Json.TryGetNumberField(TEXT("v"), V) || !Json.TryGetNumberField(TEXT("h"), H))
		{
			continue;
		}
		Json.TryGetNumberField(TEXT("yaw"), Yaw);
		// u grows east (+Y), v grows south (-X); yaw is a compass heading, which is also the engine's yaw.
		const FVector At = ChunkOrigin + FVector(-V * TileCm, U * TileCm, H * 100.0);
		const FRotator Facing(0.0, Yaw, 0.0);

		if (Kind == TEXT("tree"))
		{
			double HeightM = 7.0, RadiusM = 2.0, Conifer = 0.0;
			Json.TryGetNumberField(TEXT("s"), HeightM);
			Json.TryGetNumberField(TEXT("r"), RadiusM);
			Json.TryGetNumberField(TEXT("c"), Conifer);
			AddTree(At, Yaw, FMath::Clamp(HeightM, 2.0, 40.0), FMath::Clamp(RadiusM, 0.5, 12.0), Conifer > 0.5, World);
			continue;
		}

		FString Text;
		if (!Json.TryGetStringField(TEXT("text"), Text))
		{
			continue;
		}
		if (Kind == TEXT("house"))
		{
			const FVector BoxAt = At + FVector(0, 0, LetterboxPostHeight + LetterboxSize.Z * 0.5);
			AddBox(At + FVector(0, 0, LetterboxPostHeight * 0.5), Facing, FVector(14, 14, LetterboxPostHeight), World->MaterialFor(PostColor));
			AddBox(BoxAt, Facing, LetterboxSize, World->MaterialFor(LetterboxColor));
			// Long numbers ("12A", "3/41") shrink to stay on the box. The number is on the street side and on the back.
			const float Size = FMath::Min(NumberSize, static_cast<float>(LetterboxSize.Y * 0.9 / (FMath::Max(Text.Len(), 1) * 0.62)));
			const double Out = LetterboxSize.X * 0.5 + 0.8;
			AddText(Text, BoxAt + Facing.RotateVector(FVector(Out, 0, 0)), Facing, Size, FColor(15, 15, 15));
			AddText(Text, BoxAt + Facing.RotateVector(FVector(-Out, 0, 0)), FRotator(0.0, Yaw + 180.0, 0.0), Size, FColor(15, 15, 15));
		}
		else if (Kind == TEXT("street"))
		{
			AddBox(At + FVector(0, 0, 130), FRotator::ZeroRotator, FVector(8, 8, 260), World->MaterialFor(PostColor));
			AddPlate(Text, At + FVector(0, 0, 240), Yaw, World);
			FString Text2;
			if (Json.TryGetStringField(TEXT("text2"), Text2) && !Text2.IsEmpty())
			{
				double Yaw2 = Yaw;
				Json.TryGetNumberField(TEXT("yaw2"), Yaw2);
				AddPlate(Text2, At + FVector(0, 0, 215), Yaw2, World);
			}
		}
		else
		{
			continue;
		}
		++Count;
	}
}
