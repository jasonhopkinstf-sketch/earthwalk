#include "EarthWalkAvatar.h"

#include "Camera/PlayerCameraManager.h"
#include "Components/StaticMeshComponent.h"
#include "Components/TextRenderComponent.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"

AEarthWalkAvatar::AEarthWalkAvatar()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	// Engine basic shapes are 100 cm across and centred on their origin.
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));

	Body = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	Body->SetupAttachment(RootComponent);
	Body->SetStaticMesh(Cylinder.Object);
	Body->SetRelativeScale3D(FVector(0.45, 0.45, 1.3));
	Body->SetRelativeLocation(FVector(0, 0, 65));
	Body->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	Head = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Head"));
	Head->SetupAttachment(RootComponent);
	Head->SetStaticMesh(Sphere.Object);
	Head->SetRelativeScale3D(FVector(0.34));
	Head->SetRelativeLocation(FVector(0, 0, 150));
	Head->SetCollisionEnabled(ECollisionEnabled::NoCollision);

	Label = CreateDefaultSubobject<UTextRenderComponent>(TEXT("Label"));
	Label->SetupAttachment(RootComponent);
	Label->SetRelativeLocation(FVector(0, 0, 200));
	Label->SetHorizontalAlignment(EHTA_Center);
	Label->SetVerticalAlignment(EVRTA_TextBottom);
	Label->SetWorldSize(42.f);
	Label->SetTextRenderColor(FColor::White);
	Label->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void AEarthWalkAvatar::SetDisplayName(const FString& Name)
{
	Label->SetText(FText::FromString(Name));

	// Give each person their own colour, derived from their name.
	const uint8 Hue = static_cast<uint8>(GetTypeHash(Name) % 256);
	const FLinearColor Color = FLinearColor::MakeFromHSV8(Hue, 170, 230);
	for (UStaticMeshComponent* Part : { Body.Get(), Head.Get() })
	{
		if (UMaterialInstanceDynamic* Material = Part->CreateAndSetMaterialInstanceDynamic(0))
		{
			Material->SetVectorParameterValue(TEXT("Color"), Color);
		}
	}
}

void AEarthWalkAvatar::SetTarget(const FVector& FeetLocation, double YawDegrees)
{
	TargetLocation = FeetLocation;
	TargetYaw = YawDegrees;
}

void AEarthWalkAvatar::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	// Glide towards the latest reported position; jump if they teleported.
	const FVector Current = GetActorLocation();
	const FVector Next = FVector::DistSquared(Current, TargetLocation) > FMath::Square(5000.0)
		? TargetLocation
		: FMath::VInterpTo(Current, TargetLocation, DeltaSeconds, 10.f);
	const FRotator Facing = FMath::RInterpTo(GetActorRotation(), FRotator(0.0, TargetYaw, 0.0), DeltaSeconds, 10.f);
	SetActorLocationAndRotation(Next, Facing);

	// Keep the name readable: turn it to the viewer and grow it with distance.
	const APlayerController* Controller = GetWorld()->GetFirstPlayerController();
	if (Controller && Controller->PlayerCameraManager)
	{
		const FVector ToCamera = Controller->PlayerCameraManager->GetCameraLocation() - Label->GetComponentLocation();
		Label->SetWorldRotation(FRotator(0.0, ToCamera.Rotation().Yaw, 0.0));
		const float Size = FMath::Clamp(static_cast<float>(ToCamera.Size()) * 0.03f, 42.f, 3000.f);
		if (FMath::Abs(Size - Label->WorldSize) > Label->WorldSize * 0.05f)
		{
			Label->SetWorldSize(Size); // rebuilding text is not free, so only on a visible change
		}
	}
}
