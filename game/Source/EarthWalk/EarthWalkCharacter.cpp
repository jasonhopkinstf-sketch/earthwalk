#include "EarthWalkCharacter.h"

#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"

namespace
{
	constexpr float WalkSpeed = 450.f;
	constexpr float RunSpeed = 1100.f;
	constexpr float FlySpeed = 4000.f;
	constexpr float FastFlySpeed = 20000.f;
	constexpr float MouseLookScale = 2.5f; // same as the engine's default look scale
}

AEarthWalkCharacter::AEarthWalkCharacter()
{
	PrimaryActorTick.bCanEverTick = true;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(GetCapsuleComponent());
	Camera->SetRelativeLocation(FVector(0, 0, 64));
	Camera->bUsePawnControlRotation = true;

	bUseControllerRotationYaw = true;

	UCharacterMovementComponent* Movement = GetCharacterMovement();
	Movement->MaxWalkSpeed = WalkSpeed;
	Movement->MaxFlySpeed = FlySpeed;
	Movement->BrakingDecelerationFlying = 12000.f;
	Movement->JumpZVelocity = 480.f;
	Movement->AirControl = 0.4f;
	Movement->SetWalkableFloorAngle(60.f);
	Movement->MaxStepHeight = 60.f;
}

void AEarthWalkCharacter::BeginPlay()
{
	Super::BeginPlay();
	WaitForGround();
}

void AEarthWalkCharacter::WaitForGround()
{
	bWaitingForGround = true;
	GetCharacterMovement()->StopMovementImmediately();
	GetCharacterMovement()->SetMovementMode(MOVE_None);
}

/** Finds the ground under the player by tracing straight down; false until the terrain there has loaded. */
bool AEarthWalkCharacter::TryLand()
{
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	const FVector Here = GetActorLocation();
	if (!Earth || !Earth->HasChunkAt(Here))
	{
		return false;
	}
	FHitResult Hit;
	FCollisionQueryParams Params(FName(TEXT("EarthWalkLand")), /*bTraceComplex*/ true, this);
	const FVector Top(Here.X, Here.Y, 1000000.0);
	const FVector Bottom(Here.X, Here.Y, -100000.0);
	if (!GetWorld()->LineTraceSingleByChannel(Hit, Top, Bottom, ECC_Visibility, Params))
	{
		return false; // chunk received, but its collision is still being prepared
	}
	const double HalfHeight = GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
	SetActorLocation(Hit.ImpactPoint + FVector(0, 0, HalfHeight + 15.0), false, nullptr, ETeleportType::TeleportPhysics);
	bWaitingForGround = false;
	GetCharacterMovement()->SetMovementMode(bFlying ? MOVE_Flying : MOVE_Walking);
	return true;
}

void AEarthWalkCharacter::TeleportToGeo(double Lat, double Lon)
{
	if (AEarthWorld* Earth = AEarthWorld::Get(this))
	{
		Earth->SetOrigin(Lat, Lon);
		SetActorLocation(FVector(0, 0, GetActorLocation().Z), false, nullptr, ETeleportType::TeleportPhysics);
		WaitForGround();
	}
}

void AEarthWalkCharacter::SetFlying(bool bFly)
{
	bFlying = bFly;
	if (!bWaitingForGround)
	{
		GetCharacterMovement()->SetMovementMode(bFlying ? MOVE_Flying : MOVE_Falling);
	}
}

void AEarthWalkCharacter::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	APlayerController* PC = Cast<APlayerController>(GetController());
	if (!PC)
	{
		return;
	}

	// Looking around works even while the world is still loading.
	if (!bTyping)
	{
		const float MouseX = PC->GetInputAnalogKeyState(EKeys::MouseX);
		const float MouseY = PC->GetInputAnalogKeyState(EKeys::MouseY);
		FRotator View = PC->GetControlRotation();
		const UEarthWalkSettings* Settings = GetDefault<UEarthWalkSettings>();
		const double Scale = MouseLookScale * Settings->MouseSensitivity;
		View.Yaw += MouseX * Scale;
		View.Pitch = FMath::Clamp(FRotator::NormalizeAxis(View.Pitch) + MouseY * Scale * (Settings->bInvertMouseY ? -1.0 : 1.0), -88.0, 88.0);
		View.Roll = 0.0;
		PC->SetControlRotation(View);
	}

	if (bWaitingForGround)
	{
		TryLand();
		return;
	}

	UCharacterMovementComponent* Movement = GetCharacterMovement();

	// Never fall through a part of the world that has not arrived yet.
	if (!bFlying)
	{
		const AEarthWorld* Earth = AEarthWorld::Get(this);
		if ((Earth && !Earth->HasChunkAt(GetActorLocation())) || GetActorLocation().Z < -60000.0)
		{
			WaitForGround();
			return;
		}
	}

	if (bTyping)
	{
		return;
	}

	if (PC->WasInputKeyJustPressed(EKeys::F))
	{
		SetFlying(!bFlying);
	}

	const bool bFast = PC->IsInputKeyDown(EKeys::LeftShift) || PC->IsInputKeyDown(EKeys::RightShift);
	Movement->MaxWalkSpeed = bFast ? RunSpeed : WalkSpeed;
	Movement->MaxFlySpeed = bFast ? FastFlySpeed : FlySpeed;

	const float Forward = (PC->IsInputKeyDown(EKeys::W) ? 1.f : 0.f) - (PC->IsInputKeyDown(EKeys::S) ? 1.f : 0.f);
	const float Right = (PC->IsInputKeyDown(EKeys::D) ? 1.f : 0.f) - (PC->IsInputKeyDown(EKeys::A) ? 1.f : 0.f);
	const FRotator View = PC->GetControlRotation();
	const FRotator Heading(bFlying ? View.Pitch : 0.0, View.Yaw, 0.0);
	if (Forward != 0.f)
	{
		AddMovementInput(Heading.Vector(), Forward);
	}
	if (Right != 0.f)
	{
		AddMovementInput(FRotationMatrix(FRotator(0.0, View.Yaw, 0.0)).GetUnitAxis(EAxis::Y), Right);
	}

	if (bFlying)
	{
		const float Up = (PC->IsInputKeyDown(EKeys::SpaceBar) ? 1.f : 0.f) - (PC->IsInputKeyDown(EKeys::C) ? 1.f : 0.f);
		if (Up != 0.f)
		{
			AddMovementInput(FVector::UpVector, Up);
		}
	}
	else if (PC->WasInputKeyJustPressed(EKeys::SpaceBar))
	{
		Jump();
	}
	else if (!PC->IsInputKeyDown(EKeys::SpaceBar))
	{
		StopJumping();
	}
}
