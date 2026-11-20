#include "EarthWalkAvatar.h"

#include "EarthAnimalFigure.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/TextRenderComponent.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"

AEarthWalkAvatar::AEarthWalkAvatar()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	Figure = CreateDefaultSubobject<UEarthAnimalFigure>(TEXT("Figure"));
	Figure->SetupAttachment(RootComponent);
	Figure->SetRelativeScale3D(FVector(FigureScale));

	Label = CreateDefaultSubobject<UTextRenderComponent>(TEXT("Label"));
	Label->SetupAttachment(RootComponent);
	Label->SetRelativeLocation(FVector(0, 0, 200));
	Label->SetHorizontalAlignment(EHTA_Center);
	Label->SetVerticalAlignment(EVRTA_TextBottom);
	Label->SetWorldSize(42.f);
	Label->SetTextRenderColor(FColor::White);
	Label->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void AEarthWalkAvatar::BeginPlay()
{
	Super::BeginPlay();
	if (Figure->GetAnimal().IsEmpty())
	{
		Figure->SetAnimal(TEXT("fox"));
	}
}

void AEarthWalkAvatar::SetDisplayName(const FString& Name)
{
	Label->SetText(FText::FromString(Name));
}

void AEarthWalkAvatar::SetAnimal(const FString& Id)
{
	Figure->SetAnimal(Id);
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
	const float Speed = DeltaSeconds > 0.f ? static_cast<float>(FVector::Dist2D(Next, Current) / DeltaSeconds) : 0.f;
	Figure->Animate(DeltaSeconds, Speed > 4000.f ? 0.f : Speed, false); // a teleport is not a sprint

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
