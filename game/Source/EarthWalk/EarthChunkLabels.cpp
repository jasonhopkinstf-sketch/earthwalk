#include "EarthChunkLabels.h"

#include "EarthWorld.h"
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
	constexpr float NumberSize = 14.f; // text height in cm
	constexpr float NameSize = 16.f;
}

AEarthChunkLabels::AEarthChunkLabels()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	CubeMesh = Cube.Object;
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
		FString Kind, Text;
		double U = 0.0, V = 0.0, H = 0.0, Yaw = 0.0;
		if (!Json.TryGetStringField(TEXT("kind"), Kind) || !Json.TryGetStringField(TEXT("text"), Text) ||
			!Json.TryGetNumberField(TEXT("u"), U) || !Json.TryGetNumberField(TEXT("v"), V) || !Json.TryGetNumberField(TEXT("h"), H))
		{
			continue;
		}
		Json.TryGetNumberField(TEXT("yaw"), Yaw);
		// u grows east (+Y), v grows south (-X); yaw is a compass heading, which is also the engine's yaw.
		const FVector At = ChunkOrigin + FVector(-V * TileCm, U * TileCm, H * 100.0);
		const FRotator Facing(0.0, Yaw, 0.0);

		if (Kind == TEXT("house"))
		{
			AddBox(At + FVector(0, 0, 50), Facing, FVector(8, 8, 100), World->MaterialFor(PostColor));
			AddBox(At + FVector(0, 0, 110), Facing, FVector(18, 30, 22), World->MaterialFor(LetterboxColor));
			AddText(Text, At + FVector(0, 0, 110) + Facing.RotateVector(FVector(9.6, 0, 0)), Facing, NumberSize, FColor(20, 20, 20));
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
