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

void AEarthWalkAvatar::SetNameShown(bool bShown)
{
	if (Label)
	{
		Label->SetVisibility(bShown);
	}
}

void AEarthWalkAvatar::SetDisplayName(const FString& Name)
{
	DisplayName = Name;
	Label->SetText(FText::FromString(Name));
}

void AEarthWalkAvatar::SetHat(const FString& Id)
{
	if (Figure->GetHat() != Id)
	{
		Figure->SetHat(Id);
		Label->SetRelativeLocation(FVector(0, 0, Figure->GetHat().IsEmpty() ? 200 : 232)); // the name clears the tallest hat
	}
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
	const bool bJumped = FVector::DistSquared(Current, TargetLocation) > FMath::Square(5000.0);
	const FVector Next = bJumped ? TargetLocation : FMath::VInterpTo(Current, TargetLocation, DeltaSeconds, 10.f);
	const FRotator Before = GetActorRotation();
	const FRotator Facing = FMath::RInterpTo(Before, FRotator(0.0, TargetYaw, 0.0), DeltaSeconds, 10.f);
	SetActorLocationAndRotation(Next, Facing);

	// What they are doing, worked out from how they move: nothing about it is sent.
	GroundCheckIn -= DeltaSeconds;
	if (GroundCheckIn <= 0.f)
	{
		GroundCheckIn = 0.15f;
		FHitResult Hit;
		FCollisionQueryParams Params(SCENE_QUERY_STAT(EarthAvatarGround), false, this);
		const bool bFound = GetWorld()->LineTraceSingleByChannel(Hit, Next + FVector(0.0, 0.0, 60.0), Next - FVector(0.0, 0.0, 100000.0), ECC_Visibility, Params);
		AboveGroundCm = bFound ? static_cast<float>(Next.Z - Hit.ImpactPoint.Z) : 0.f;
	}
	FEarthFigureMotion Motion;
	float Climb = 0.f;
	if (DeltaSeconds > 0.f && !bJumped) // a teleport is not a sprint
	{
		Motion.Speed = FMath::Min(static_cast<float>(FVector::Dist2D(Next, Current) / DeltaSeconds), 6000.f);
		Motion.Turn = FMath::FindDeltaAngleDegrees(static_cast<float>(Before.Yaw), static_cast<float>(Facing.Yaw)) / DeltaSeconds;
		Climb = static_cast<float>((Next.Z - Current.Z) / DeltaSeconds);
	}
	// Well clear of the ground is flying; a little clear and rising or falling is a jump.
	Motion.bSeated = bSeated;
	Motion.bFlying = !bSeated && AboveGroundCm > 250.f;
	Motion.bInAir = !bSeated && (Motion.bFlying || (AboveGroundCm > 50.f && FMath::Abs(Climb) > 80.f));
	// Somebody whose place and heading have not changed for half a minute fidgets, and talks to themselves.
	const bool bStill = !EarthIdle::bQuiet && !bSeated && !Motion.bFlying && !Motion.bInAir && TargetLocation.Equals(IdlePlace, 1.0)
		&& FMath::Abs(FMath::FindDeltaAngleDegrees(static_cast<float>(TargetYaw), static_cast<float>(IdleYaw))) < 0.1f;
	IdlePlace = TargetLocation;
	IdleYaw = TargetYaw;
	StillFor = bStill ? StillFor + DeltaSeconds : 0.0;
	EarthIdle::FNow Idle;
	if (EarthIdle::At(StillFor, IdleSeed, Idle))
	{
		FEarthFidget Pose;
		EarthIdle::Pose(Idle.Fidget, Idle.U, Pose);
		Figure->SetFidget(&Pose);
		if (Idle.N != IdleCycle || IdleSay == -2)
		{
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: idle: %s, cycle %d, fidget %d, after %.1f s of standing"), *DisplayName, Idle.N, Idle.Fidget, StillFor);
		}
		IdleSay = Idle.Say;
		IdleCycle = Idle.N;
	}
	else
	{
		Figure->SetFidget(nullptr);
		IdleSay = -1;
		IdleCycle = -1; // so that the first cycle is told of in the log
	}
	Figure->Animate(DeltaSeconds, Motion);

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
