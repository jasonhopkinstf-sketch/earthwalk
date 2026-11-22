#include "EarthWalkCharacter.h"

#include "EarthAnimalFigure.h"
#include "EarthMounts.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Camera/CameraComponent.h"
#include "Components/CapsuleComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "GameFramework/CharacterMovementComponent.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputCoreTypes.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "TimerManager.h"
#include "UnrealClient.h"

namespace
{
	constexpr float WalkSpeed = 450.f;
	constexpr float RunSpeed = 1100.f;
	constexpr float FlySpeed = 4000.f;
	constexpr float FastFlySpeed = 20000.f;
	constexpr float MouseLookScale = 2.5f; // same as the engine's default look scale
	constexpr float TurnDegreesPerSecond = 120.f; // arrow keys
	constexpr float TiltDegreesPerSecond = 80.f;
	constexpr float ZoomStep = 1.15f; // per wheel notch
	constexpr double EyeAboveCentreCm = 64.0; // where the camera's arm hangs when on foot
	constexpr double RidingEyeCm = 85.0; // eyes above the seat (RIDING_EYE in server/public/js/player.js)
}

AEarthWalkCharacter::AEarthWalkCharacter()
{
	PrimaryActorTick.bCanEverTick = true;

	// The camera hangs off a spring arm so it can sit at eye level (arm length 0) or behind the figure.
	Boom = CreateDefaultSubobject<USpringArmComponent>(TEXT("Boom"));
	Boom->SetupAttachment(GetCapsuleComponent());
	Boom->SetRelativeLocation(FVector(0, 0, 64));
	Boom->bUsePawnControlRotation = true;
	Boom->bInheritPitch = true;
	Boom->bInheritYaw = true;
	Boom->bInheritRoll = false;
	Boom->TargetArmLength = 0.f;
	Boom->bDoCollisionTest = false;
	Boom->ProbeSize = 12.f;
	Boom->ProbeChannel = ECC_Camera;
	Boom->bEnableCameraLag = false;
	Boom->CameraLagSpeed = 12.f;
	Boom->CameraLagMaxDistance = 150.f;
	Boom->bEnableCameraRotationLag = false;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Boom, USpringArmComponent::SocketName);
	Camera->bUsePawnControlRotation = false;

	// The player's own animal, visible in the third-person views.
	Figure = CreateDefaultSubobject<UEarthAnimalFigure>(TEXT("Figure"));
	Figure->SetupAttachment(GetCapsuleComponent());
	Figure->SetRelativeLocation(FVector(0, 0, -GetCapsuleComponent()->GetUnscaledCapsuleHalfHeight()));
	Figure->SetRelativeScale3D(FVector(AEarthWalkAvatar::FigureScale));
	Figure->SetVisibility(false, true);

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
	RefreshFigure();
	int32 StartView = 0;
	if (FParse::Value(FCommandLine::Get(), TEXT("-EWView="), StartView))
	{
		View = static_cast<EEarthView>(FMath::Clamp(StartView, 0, 2));
	}
	ApplyView();
	WaitForGround();
	FParse::Value(FCommandLine::Get(), TEXT("-EWShot="), ShotFile);
	bAutoWalk = FParse::Param(FCommandLine::Get(), TEXT("EWWalk"));
	bShotWithUI = FParse::Param(FCommandLine::Get(), TEXT("EWShotUI"));
	FParse::Value(FCommandLine::Get(), TEXT("-EWShotDelay="), ShotDelay);
	FParse::Value(FCommandLine::Get(), TEXT("-EWFly="), StartFlyMeters);
	bHandsOff = !ShotFile.IsEmpty();
	// Our +X is north and +Y east, so a compass heading is the engine yaw as it stands.
	const bool bYaw = FParse::Value(FCommandLine::Get(), TEXT("-EWYaw="), StartLook.Yaw);
	const bool bPitch = FParse::Value(FCommandLine::Get(), TEXT("-EWPitch="), StartLook.Pitch);
	bStartLookPending = bYaw || bPitch;
}

void AEarthWalkCharacter::RefreshFigure()
{
	Figure->SetAnimal(FEarthWalkConfig::Avatar());
	const UEarthWalkNet* Room = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	// -EWHat=<id> puts a hat on this player's own figure whatever the server says, for pictures.
	FString TestHat;
	FParse::Value(FCommandLine::Get(), TEXT("-EWHat="), TestHat);
	Figure->SetHat(!TestHat.IsEmpty() ? TestHat : Room ? Room->GetMyHat() : FString());
}

void AEarthWalkCharacter::CycleView()
{
	switch (View)
	{
	case EEarthView::FirstPerson: View = EEarthView::Shoulder; break;
	case EEarthView::Shoulder: View = EEarthView::Far; break;
	default: View = EEarthView::FirstPerson; break;
	}
	ApplyView();
}

void AEarthWalkCharacter::ApplyView()
{
	const bool bThirdPerson = View != EEarthView::FirstPerson;
	Boom->bDoCollisionTest = bThirdPerson;
	Boom->bEnableCameraLag = bThirdPerson;
	Figure->SetVisibility(bThirdPerson, true);
	switch (View)
	{
	case EEarthView::Shoulder:
		ArmTarget = ShoulderDistance;
		Boom->SocketOffset = FVector(0, 45, 40);
		Boom->TargetOffset = FVector(0, 0, 30);
		break;
	case EEarthView::Far:
		ArmTarget = FarDistance;
		Boom->SocketOffset = FVector(0, 0, 80);
		Boom->TargetOffset = FVector(0, 0, 30);
		break;
	default:
		ArmTarget = 0.f;
		Boom->TargetArmLength = 0.f; // snap, so your own head is never in shot
		Boom->SocketOffset = FVector::ZeroVector;
		Boom->TargetOffset = FVector::ZeroVector;
		break;
	}
}

FVector AEarthWalkCharacter::FeetLocation() const
{
	return GetActorLocation() - FVector(0.0, 0.0, GetCapsuleComponent()->GetScaledCapsuleHalfHeight());
}

void AEarthWalkCharacter::PlaceFeetAt(const FVector& Feet)
{
	SetActorLocation(Feet + FVector(0.0, 0.0, GetCapsuleComponent()->GetScaledCapsuleHalfHeight()), false, nullptr, ETeleportType::TeleportPhysics);
	GetCharacterMovement()->StopMovementImmediately();
	bHasGoodSpot = false;
}

double AEarthWalkCharacter::SeatLiftCm() const
{
	return Mount ? Mount->Seat * 100.0 : 0.0;
}

/** Raises the figure and the eyes to the seat, or puts them back. */
void AEarthWalkCharacter::ApplySeat()
{
	const double HalfHeight = GetCapsuleComponent()->GetUnscaledCapsuleHalfHeight();
	const double Lift = SeatLiftCm();
	Figure->SetRelativeLocation(FVector(0.0, 0.0, -HalfHeight + Lift));
	Boom->SetRelativeLocation(FVector(0.0, 0.0, Mount || bCarried ? -HalfHeight + Lift + RidingEyeCm : EyeAboveCentreCm));
}

void AEarthWalkCharacter::SetMount(const FEarthMount* InMount)
{
	Mount = InMount;
	bHasGoodSpot = false;
	bAutopilot = false;
	if (Mount)
	{
		bFlying = false;
		if (!bWaitingForGround)
		{
			GetCharacterMovement()->SetMovementMode(MOVE_Falling); // onto its back; walking again once the ground is felt
		}
	}
	else
	{
		GetCharacterMovement()->MaxWalkSpeed = WalkSpeed;
	}
	ApplySeat();
}

void AEarthWalkCharacter::SetCarried(bool bInCarried)
{
	if (bCarried == bInCarried)
	{
		return;
	}
	bCarried = bInCarried;
	if (bCarried)
	{
		bFlying = false;
	}
	if (!bWaitingForGround)
	{
		GetCharacterMovement()->StopMovementImmediately();
		GetCharacterMovement()->SetMovementMode(bCarried ? MOVE_None : MOVE_Falling);
	}
	ApplySeat();
}

void AEarthWalkCharacter::SetAutopilot(const FVector2D& NorthEast, double Pace)
{
	bAutopilot = true;
	AutoNorthEast = NorthEast;
	AutoPace = Pace;
}

/** Moving while on a mount: at its pace, where the player steers or where it is taking them. */
void AEarthWalkCharacter::RideTick(float DeltaSeconds, APlayerController* PC)
{
	UCharacterMovementComponent* Movement = GetCharacterMovement();
	const auto Down = [this, PC](const FKey& Key) { return !bHandsOff && !bTyping && PC->IsInputKeyDown(Key); };
	const float Forward = (Down(EKeys::W) ? 1.f : 0.f) - (Down(EKeys::S) ? 1.f : 0.f);
	const float Right = (Down(EKeys::D) ? 1.f : 0.f) - (Down(EKeys::A) ? 1.f : 0.f);
	bSteering = Forward != 0.f || Right != 0.f;
	// Being taken somewhere: the mount finds its own way until the rider steers.
	const bool bAuto = !bSteering && bAutopilot;

	// A boat keeps to the water, and everything else keeps off it. (Being driven along a road, a bridge
	// is a bridge, whatever lies under it.)
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	const FVector Here = GetActorLocation();
	bool bWet = false;
	if (Earth && !bAuto && bHasGoodSpot && Earth->WaterAt(Here.Y / 100.0, -Here.X / 100.0, bWet) && bWet != Mount->bAfloat)
	{
		SetActorLocation(GoodSpot, false, nullptr, ETeleportType::TeleportPhysics);
		Movement->StopMovementImmediately();
	}
	else
	{
		GoodSpot = Here;
		bHasGoodSpot = true;
	}

	if (!bHandsOff && !bTyping && PC->WasInputKeyJustPressed(EKeys::Two))
	{
		bRunToggled = !bRunToggled;
	}
	if (!bHandsOff && !bTyping && PC->WasInputKeyJustPressed(EKeys::One))
	{
		bRunToggled = false;
	}
	bRunningNow = Down(EKeys::LeftShift) || Down(EKeys::RightShift) || bRunToggled;
	Movement->MaxWalkSpeed = static_cast<float>(Mount->Speed * 100.0 * (bAuto ? AutoPace : bRunningNow ? 1.0 : 0.55));
	if (bAuto)
	{
		AddMovementInput(FVector(AutoNorthEast.X, AutoNorthEast.Y, 0.0), 1.f);
	}
	else
	{
		const FRotator Look = PC->GetControlRotation();
		if (Forward != 0.f)
		{
			AddMovementInput(FRotator(0.0, Look.Yaw, 0.0).Vector(), Forward);
		}
		if (Right != 0.f)
		{
			AddMovementInput(FRotationMatrix(FRotator(0.0, Look.Yaw, 0.0)).GetUnitAxis(EAxis::Y), Right);
		}
	}
	StopJumping();
}

void AEarthWalkCharacter::WaitForGround()
{
	bWaitingForGround = true;
	bParkedAtPhotoGround = false;
	GetCharacterMovement()->StopMovementImmediately();
	GetCharacterMovement()->SetMovementMode(MOVE_None);
}

/**
 * In the photographic world the height of the ground arrives before the tiles do. Waiting there, at
 * head height, makes the plugin load what the player is about to see; waiting where a teleport left
 * them (often under the photographic ground) makes it load a great deal that they never will.
 */
void AEarthWalkCharacter::ParkAtPhotoGround()
{
	AEarthWorld* Earth = AEarthWorld::Get(this);
	const FVector Here = GetActorLocation();
	double GroundZ = 0.0;
	// The answer is for the origin; a few steps away the ground can already be a roof higher.
	if (bParkedAtPhotoGround || !Earth || Here.Size2D() > 300.0 || !Earth->PhotoGroundAtOrigin(GroundZ))
	{
		return;
	}
	bParkedAtPhotoGround = true;
	const double HalfHeight = GetCapsuleComponent()->GetScaledCapsuleHalfHeight();
	SetActorLocation(FVector(Here.X, Here.Y, GroundZ + HalfHeight + 15.0), false, nullptr, ETeleportType::TeleportPhysics);
	Earth->RestartPhotoWait();
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
	// Parked at the photographic ground: look from just above it first, so a coarse stand-in tile that
	// has not been replaced yet and pokes up overhead is not mistaken for the street.
	const bool bNear = bParkedAtPhotoGround
		&& GetWorld()->LineTraceSingleByChannel(Hit, FVector(Here.X, Here.Y, Here.Z + 1000.0), Bottom, ECC_Visibility, Params);
	if (!bNear && !GetWorld()->LineTraceSingleByChannel(Hit, Top, Bottom, ECC_Visibility, Params))
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
	if (bFly && (Mount || bCarried))
	{
		return; // not while riding
	}
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

	const bool bThirdPerson = View != EEarthView::FirstPerson;

	if (bStartLookPending)
	{
		bStartLookPending = false;
		PC->SetControlRotation(StartLook);
	}

	// Looking around works even while the world is still loading. The mouse only looks while the
	// left button is held, so a trackpad brush does not spin the view; the arrow keys always do.
	if (!bTyping && !bHandsOff)
	{
		const UEarthWalkSettings* Settings = GetDefault<UEarthWalkSettings>();
		FRotator Look = PC->GetControlRotation();
		double Pitch = FRotator::NormalizeAxis(Look.Pitch);
		if (PC->IsInputKeyDown(EKeys::LeftMouseButton))
		{
			const double Scale = MouseLookScale * Settings->MouseSensitivity;
			Look.Yaw += PC->GetInputAnalogKeyState(EKeys::MouseX) * Scale;
			Pitch += PC->GetInputAnalogKeyState(EKeys::MouseY) * Scale * (Settings->bInvertMouseY ? -1.0 : 1.0);
		}
		const float Turn = (PC->IsInputKeyDown(EKeys::Right) ? 1.f : 0.f) - (PC->IsInputKeyDown(EKeys::Left) ? 1.f : 0.f);
		const float Tilt = (PC->IsInputKeyDown(EKeys::Up) ? 1.f : 0.f) - (PC->IsInputKeyDown(EKeys::Down) ? 1.f : 0.f);
		Look.Yaw += Turn * TurnDegreesPerSecond * DeltaSeconds;
		Pitch += Tilt * TiltDegreesPerSecond * DeltaSeconds;
		// Behind the figure, looking too far down would put the camera in the ground.
		Look.Pitch = bThirdPerson ? FMath::Clamp(Pitch, -70.0, 60.0) : FMath::Clamp(Pitch, -88.0, 88.0);
		Look.Roll = 0.0;
		PC->SetControlRotation(Look);

		if (PC->WasInputKeyJustPressed(EKeys::V))
		{
			CycleView();
		}
		if (bThirdPerson)
		{
			const float MinArm = View == EEarthView::Shoulder ? 120.f : 400.f;
			const float MaxArm = View == EEarthView::Shoulder ? 500.f : 2500.f;
			if (PC->WasInputKeyJustPressed(EKeys::MouseScrollUp))
			{
				ArmTarget = FMath::Clamp(ArmTarget / ZoomStep, MinArm, MaxArm);
			}
			if (PC->WasInputKeyJustPressed(EKeys::MouseScrollDown))
			{
				ArmTarget = FMath::Clamp(ArmTarget * ZoomStep, MinArm, MaxArm);
			}
			(View == EEarthView::Shoulder ? ShoulderDistance : FarDistance) = ArmTarget;
		}
	}
	if (bThirdPerson)
	{
		Boom->TargetArmLength = FMath::FInterpTo(Boom->TargetArmLength, ArmTarget, DeltaSeconds, 10.f);
	}
	// What the player's own figure is doing. Sitting on something, the legs are still: it is the mount that walks.
	{
		FEarthFigureMotion Motion;
		const float Yaw = static_cast<float>(GetActorRotation().Yaw);
		Motion.Speed = bWaitingForGround ? 0.f : static_cast<float>(GetVelocity().Size2D());
		Motion.Turn = DeltaSeconds > 0.f ? FMath::FindDeltaAngleDegrees(FigureYaw, Yaw) / DeltaSeconds : 0.f;
		FigureYaw = Yaw;
		Motion.bSeated = Mount != nullptr || bCarried;
		Motion.bFlying = bFlying && !bWaitingForGround;
		Motion.bInAir = !bWaitingForGround && !Motion.bSeated && GetCharacterMovement()->IsFalling();
		Figure->Animate(DeltaSeconds, Motion);
	}

	if (bWaitingForGround)
	{
		bRunningNow = false;
		ParkAtPhotoGround();
		if (!TryLand())
		{
			return;
		}
		if (StartFlyMeters > 0.f)
		{
			SetFlying(true);
			AddActorWorldOffset(FVector(0.0, 0.0, StartFlyMeters * 100.0), false, nullptr, ETeleportType::TeleportPhysics);
			StartFlyMeters = 0.f;
		}
		if (!ShotFile.IsEmpty() && ShotCountdown < 0.f)
		{
			ShotCountdown = FMath::Max(ShotDelay, 0.f); // let the nearby chunks and shaders settle first
		}
		return;
	}

	if (ShotCountdown >= 0.f)
	{
		ShotCountdown -= DeltaSeconds;
		if (ShotCountdown < 0.f)
		{
			FScreenshotRequest::RequestScreenshot(ShotFile, bShotWithUI, false);
			ShotCountdown = -1.f;
			ShotFile.Reset();
			// Give the screenshot a couple of seconds to be written, then leave.
			FTimerHandle QuitTimer;
			GetWorld()->GetTimerManager().SetTimer(QuitTimer, []() { FPlatformMisc::RequestExit(false); }, 2.f, false);
		}
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

	bSteering = false;
	if (bCarried)
	{
		bRunningNow = false;
		return; // put where the train, or the friend who is steering, has got to
	}
	if (Mount)
	{
		RideTick(DeltaSeconds, PC);
		return;
	}

	if (bTyping)
	{
		return;
	}

	const auto Down = [this, PC](const FKey& Key) { return !bHandsOff && PC->IsInputKeyDown(Key); };
	const auto Pressed = [this, PC](const FKey& Key) { return !bHandsOff && PC->WasInputKeyJustPressed(Key); };

	if (Pressed(EKeys::F))
	{
		SetFlying(!bFlying);
	}

	// Running: hold Shift, or press 2 to keep running until 1 (or 2 again).
	if (Pressed(EKeys::Two))
	{
		bRunToggled = !bRunToggled;
	}
	if (Pressed(EKeys::One))
	{
		bRunToggled = false;
	}
	const bool bShift = Down(EKeys::LeftShift) || Down(EKeys::RightShift);
	bRunningNow = bShift || bRunToggled;
	Movement->MaxWalkSpeed = bRunningNow ? RunSpeed : WalkSpeed;
	Movement->MaxFlySpeed = bRunningNow ? FastFlySpeed : FlySpeed;

	const float Forward = (Down(EKeys::W) || bAutoWalk ? 1.f : 0.f) - (Down(EKeys::S) ? 1.f : 0.f);
	const float Right = (Down(EKeys::D) ? 1.f : 0.f) - (Down(EKeys::A) ? 1.f : 0.f);
	bSteering = Forward != 0.f || Right != 0.f;
	const FRotator Look = PC->GetControlRotation();
	const FRotator Heading(bFlying ? Look.Pitch : 0.0, Look.Yaw, 0.0);
	if (Forward != 0.f)
	{
		AddMovementInput(Heading.Vector(), Forward);
	}
	if (Right != 0.f)
	{
		AddMovementInput(FRotationMatrix(FRotator(0.0, Look.Yaw, 0.0)).GetUnitAxis(EAxis::Y), Right);
	}

	if (bFlying)
	{
		const float Up = (Down(EKeys::SpaceBar) ? 1.f : 0.f) - (Down(EKeys::C) ? 1.f : 0.f);
		if (Up != 0.f)
		{
			AddMovementInput(FVector::UpVector, Up);
		}
	}
	else if (Pressed(EKeys::SpaceBar))
	{
		Jump();
	}
	else if (!Down(EKeys::SpaceBar))
	{
		StopJumping();
	}
}
