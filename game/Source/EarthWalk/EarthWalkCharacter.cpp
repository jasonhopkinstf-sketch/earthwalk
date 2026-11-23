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

namespace
{
	/** The views while riding: how far off the camera hovers, in metres, and how steeply it looks down, in degrees. As VIEWS in player.js. */
	const struct FRideView { double FarM; double TiltDeg; const TCHAR* Name; } RideViews[] = {
		{ 0.0, 0.0, TEXT("your seat") },
		{ 17.0, 28.6, TEXT("from above") },
		{ 62.0, 48.7, TEXT("from high up") },
	};
	/** Being carried, the hovering camera circles slowly until the mouse says where to look: degrees a second. */
	constexpr double RideDriftDeg = 5.2;
}

FString AEarthWalkCharacter::NextRideView()
{
	if (!Mount && !bCarried)
	{
		return FString();
	}
	SetRideView((RideView + 1) % UE_ARRAY_COUNT(RideViews));
	return RideViews[RideView].Name;
}

void AEarthWalkCharacter::SetRideView(int32 NewView)
{
	RideView = FMath::Clamp(NewView, 0, static_cast<int32>(UE_ARRAY_COUNT(RideViews)) - 1);
	RideZoom = 1.0;
	RideOrbit = 0.0;
	RideLift = 0.0;
	RideTiltNow = 0.0;
	bRideDrift = RideView > 0;
	RideWas = GetActorLocation();
	RideCourse = FacingYaw();
	const bool bHover = RideView > 0;
	// Hovering, the arm is pointed by HoverTick, whichever way the player or the car is facing.
	Boom->bUsePawnControlRotation = !bHover;
	Boom->SetUsingAbsoluteRotation(bHover);
	if (bHover)
	{
		Boom->bDoCollisionTest = false; // HoverTick looks from steeper instead, over the rooftops
		Boom->bEnableCameraLag = false;
		Boom->SocketOffset = FVector::ZeroVector;
		Boom->TargetOffset = FVector(0, 0, 60);
		Figure->SetVisibility(true, true);
	}
	else
	{
		Boom->SetRelativeRotation(FRotator::ZeroRotator);
		if (IsDriving())
		{
			ApplyDriveView();
		}
		else
		{
			ApplyView();
		}
	}
}

/**
 * The camera hovering over the ride, looking down at it. Steering, it stays behind; taken along, it
 * follows the way the ride is going, circles slowly by itself, and goes where the mouse swings it.
 */
void AEarthWalkCharacter::HoverTick(float DeltaSeconds, APlayerController* PC)
{
	if (!Mount && !bCarried)
	{
		SetRideView(0); // on foot again
		return;
	}
	// Which way the ride is going, from where it was a frame ago.
	const FVector Here = GetActorLocation();
	const FVector Step = Here - RideWas;
	RideWas = Here;
	const double Moved = Step.Size2D();
	if (DeltaSeconds > 0.f && Moved < 5000.0 && Moved / DeltaSeconds > 100.0)
	{
		const double Going = FMath::RadiansToDegrees(FMath::Atan2(Step.Y, Step.X));
		RideCourse += FMath::FindDeltaAngleDegrees(RideCourse, Going) * (1.0 - FMath::Exp(-2.5 * DeltaSeconds));
	}
	if (IsTaken())
	{
		if (bRideDrift)
		{
			RideOrbit += RideDriftDeg * DeltaSeconds;
		}
	}
	else
	{
		// At the reins again: the camera comes back round behind.
		RideOrbit = FRotator::NormalizeAxis(RideOrbit) * FMath::Exp(-4.0 * DeltaSeconds);
	}
	// A train or a friend carries the player whichever way they look; anything else goes the way the player (or its own autopilot) is turned.
	const double Yaw = (bCarried ? RideCourse : PC->GetControlRotation().Yaw) + RideOrbit;
	const double Far = RideViews[RideView].FarM * 100.0 * RideZoom;
	const double WantTilt = FMath::Clamp(RideViews[RideView].TiltDeg + RideLift, 7.0, 83.0);

	// Over the rooftops, not behind them: where a building is in the way, look from steeper; under a roof, come in close.
	const FVector Eye = Boom->GetComponentLocation() + Boom->TargetOffset;
	FCollisionQueryParams Params(SCENE_QUERY_STAT(EarthWalkHover), false, this);
	double Tilt = WantTilt;
	double Arm = Far;
	for (;;)
	{
		FHitResult Hit;
		const FVector Back = -FRotator(-Tilt, Yaw, 0.0).Vector();
		if (!GetWorld()->LineTraceSingleByChannel(Hit, Eye, Eye + Back * (Far + 50.0), ECC_Camera, Params))
		{
			break;
		}
		if (Tilt >= 86.0)
		{
			Arm = FMath::Max(Far * 0.1, static_cast<double>(Hit.Distance) - 50.0);
			break;
		}
		Tilt = FMath::Min(86.0, Tilt + 11.5);
	}
	RideTiltNow = RideTiltNow <= 0.0 ? Tilt : FMath::FInterpTo(RideTiltNow, Tilt, DeltaSeconds, 5.0);
	Boom->TargetArmLength = FMath::FInterpTo(Boom->TargetArmLength, static_cast<float>(Arm), DeltaSeconds, 6.f);
	Boom->SetWorldRotation(FRotator(-RideTiltNow, Yaw, 0.0));
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

double AEarthWalkCharacter::FacingYaw() const
{
	if (IsDriving())
	{
		return FMath::RadiansToDegrees(Car.Heading);
	}
	const AController* Mind = GetController();
	return Mind ? Mind->GetControlRotation().Yaw : GetActorRotation().Yaw;
}

/** The camera behind and above the car, with the figure in view on its roof. */
void AEarthWalkCharacter::ApplyDriveView()
{
	Boom->bDoCollisionTest = true; // never behind a wall
	Boom->bEnableCameraLag = false;
	Boom->SocketOffset = FVector(0, 0, 60);
	Boom->TargetOffset = FVector(0, 0, 30);
	Figure->SetVisibility(true, true);
}

/** A car coasts and slides by its own sums, so the ground must not slow it as it does a walker. */
void AEarthWalkCharacter::SetDriveFriction(bool bDriving)
{
	if (bDriving == bDriveFriction)
	{
		return;
	}
	bDriveFriction = bDriving;
	UCharacterMovementComponent* Movement = GetCharacterMovement();
	Movement->GroundFriction = bDriving ? 0.f : 8.f;
	Movement->BrakingDecelerationWalking = bDriving ? 0.f : 2048.f;
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
	if (RideView != 0 && InMount != Mount)
	{
		SetRideView(0); // on or off something else: back to the seat's own view first
	}
	APlayerController* PC = Cast<APlayerController>(GetController());
	if (IsDriving() && PC)
	{
		// Out of the car: looking the way it points, level.
		PC->SetControlRotation(FRotator(0.0, FMath::RadiansToDegrees(Car.Heading), 0.0));
	}
	Mount = InMount;
	bHasGoodSpot = false;
	bAutopilot = false;
	bHasWant = false;
	SetDriveFriction(false);
	bUseControllerRotationYaw = !IsDriving();
	if (IsDriving())
	{
		// At the wheel: the car points the way the player was looking, and the camera goes behind it.
		const FRotator Look = PC ? PC->GetControlRotation() : GetActorRotation();
		Car = FEarthCar();
		Car.Heading = Car.View = FMath::DegreesToRadians(Look.Yaw);
		if (PC)
		{
			PC->SetControlRotation(FRotator(-14.0, Look.Yaw, 0.0));
		}
		ApplyDriveView();
	}
	else
	{
		ApplyView();
	}
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
	if (RideView != 0 && !bInCarried && !Mount)
	{
		SetRideView(0);
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
	// -EWWalk holds W down, and -EWSteer=<-1 to 1> holds the wheel over, for pictures of driving.
	static const float TestSteer = []() { float Value = 0.f; FParse::Value(FCommandLine::Get(), TEXT("-EWSteer="), Value); return Value; }();
	const float Forward = (Down(EKeys::W) || bAutoWalk ? 1.f : 0.f) - (Down(EKeys::S) ? 1.f : 0.f);
	const float Right = (Down(EKeys::D) ? 1.f : 0.f) - (Down(EKeys::A) ? 1.f : 0.f) + (bAutoWalk ? TestSteer : 0.f);
	bSteering = Forward != 0.f || Right != 0.f;
	// Being taken somewhere: the mount finds its own way until the rider steers.
	const bool bAuto = !bSteering && bAutopilot;

	// A boat keeps to the water, and everything else keeps off it. (Being driven along a road, a bridge
	// is a bridge, whatever lies under it.)
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	const FVector Here = GetActorLocation();
	bool bWet = false;
	// On a bridge the water is far below: whatever is ridden over it is on the deck, not in the sea.
	double Under = 0.0;
	const bool bOnDeck = Earth && Earth->TerrainHeightAt(Here.Y / 100.0, -Here.X / 100.0, Under) && FeetLocation().Z / 100.0 > Under + 1.5;
	if (Earth && !bAuto && !bOnDeck && bHasGoodSpot && Earth->WaterAt(Here.Y / 100.0, -Here.X / 100.0, bWet) && bWet != Mount->bAfloat)
	{
		SetActorLocation(GoodSpot, false, nullptr, ETeleportType::TeleportPhysics);
		Movement->StopMovementImmediately();
		Car.Vx = Car.Vz = Car.Speed = 0.0; // the water's edge
		bHasWant = false;
	}
	else
	{
		GoodSpot = Here;
		bHasGoodSpot = true;
	}
	if (IsDriving())
	{
		DriveTick(DeltaSeconds, PC, Forward, Right, Down(EKeys::SpaceBar), bAuto);
		return;
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

/**
 * At the wheel: the car's speed and heading move on by its own sums (EarthMounts::StepCar), and the
 * player is carried at that velocity as far as the walls allow. A wall takes half of what is left: a
 * bump, never a crash. When the car is taking its driver somewhere it follows the road by itself.
 */
void AEarthWalkCharacter::DriveTick(float DeltaSeconds, APlayerController* PC, float Throttle, float Steer, bool bHandbrake, bool bAuto)
{
	UCharacterMovementComponent* Movement = GetCharacterMovement();
	const double Dt = FMath::Min(0.1, static_cast<double>(DeltaSeconds));
	FRotator Look = PC->GetControlRotation();
	const FVector Going = GetVelocity();
	if (bAuto)
	{
		SetDriveFriction(false);
		Movement->MaxWalkSpeed = static_cast<float>(Mount->Speed * 100.0 * AutoPace);
		AddMovementInput(FVector(AutoNorthEast.X, AutoNorthEast.Y, 0.0), 1.f);
		// The car's own state follows, so that taking the wheel again starts from how it is going.
		Car.Heading = Car.View = FMath::DegreesToRadians(Look.Yaw);
		Car.Look = 0.0;
		Car.Vx = Going.Y / 100.0;
		Car.Vz = -Going.X / 100.0;
		Car.Speed = FMath::Sqrt(Car.Vx * Car.Vx + Car.Vz * Car.Vz);
		Car.Steer = Car.Turn = 0.0;
		bHasWant = false;
	}
	else
	{
		SetDriveFriction(true);
		// What the walls allowed of the last step: where a good part of it is gone, the car keeps half of what is left.
		if (bHasWant)
		{
			const double GotVx = Going.Y / 100.0, GotVz = -Going.X / 100.0;
			const double Wanted = FMath::Sqrt(WantVx * WantVx + WantVz * WantVz);
			const double Lost = FMath::Sqrt((GotVx - WantVx) * (GotVx - WantVx) + (GotVz - WantVz) * (GotVz - WantVz));
			if (Wanted > 1.0 && Lost > 0.25 * Wanted)
			{
				Car.Vx = GotVx * 0.5;
				Car.Vz = GotVz * 0.5;
				Car.Speed = Car.Vx * FMath::Sin(Car.Heading) - Car.Vz * FMath::Cos(Car.Heading);
			}
		}
		EarthMounts::StepCar(Car, *Mount, Dt, Throttle, Steer, bHandbrake);
		Movement->MaxWalkSpeed = static_cast<float>(Mount->Top * 130.0);
		Movement->Velocity = FVector(-Car.Vz * 100.0, Car.Vx * 100.0, Movement->Velocity.Z);
		WantVx = Car.Vx;
		WantVz = Car.Vz;
		bHasWant = true;
		// The camera swings back behind the car once the mouse has been left alone and the car moves on.
		Car.Idle += Dt;
		if (Car.Idle > 1.2 && FMath::Abs(Car.Speed) > 1.5)
		{
			Car.Look *= FMath::Exp(-2.5 * Dt);
		}
		Car.View += FMath::FindDeltaAngleRadians(Car.View, Car.Heading + Car.Look) * (1.0 - FMath::Exp(-6.0 * Dt));
		Look.Yaw = FMath::RadiansToDegrees(Car.View);
		PC->SetControlRotation(Look);
	}
	SetActorRotation(FRotator(0.0, FMath::RadiansToDegrees(Car.Heading), 0.0));
	if (RideView == 0)
	{
		Boom->TargetArmLength = FMath::FInterpTo(Boom->TargetArmLength, static_cast<float>((6.8 + FMath::Abs(Car.Speed) * 0.07) * 100.0), DeltaSeconds, 6.f);
	}
	bRunningNow = false;
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
		if (RideView > 0)
		{
			// From above, looking up and down lowers and raises the hovering camera; and while something
			// else is doing the steering, looking round swings the camera round the ride.
			const FRotator Was = PC->GetControlRotation();
			const double WasPitch = FRotator::NormalizeAxis(Was.Pitch);
			RideLift = FMath::Clamp(RideLift - (Pitch - WasPitch) * 0.7, -30.0, 45.0);
			Pitch = WasPitch;
			if (IsTaken())
			{
				const double Round = FMath::FindDeltaAngleDegrees(Was.Yaw, Look.Yaw);
				if (Round != 0.0)
				{
					RideOrbit += Round;
					bRideDrift = false;
				}
				Look.Yaw = Was.Yaw;
			}
		}
		if (IsDriving())
		{
			// At the wheel the mouse and the arrow keys look round the car; the car goes where it is steered.
			const double Swung = FMath::FindDeltaAngleDegrees(PC->GetControlRotation().Yaw, Look.Yaw);
			if (Swung != 0.0)
			{
				Car.Look += FMath::DegreesToRadians(Swung);
				Car.Idle = 0.0;
			}
			Look.Yaw = PC->GetControlRotation().Yaw;
		}
		// Behind the figure, looking too far down would put the camera in the ground.
		Look.Pitch = IsDriving() ? FMath::Clamp(Pitch, -60.0, 8.0) : bThirdPerson ? FMath::Clamp(Pitch, -70.0, 60.0) : FMath::Clamp(Pitch, -88.0, 88.0);
		Look.Roll = 0.0;
		PC->SetControlRotation(Look);

		if (PC->WasInputKeyJustPressed(EKeys::V) && (Mount || bCarried))
		{
			// Riding or being carried: the seat, the view from above, the view from high up.
			const FString Name = NextRideView();
			if (const UEarthWalkNet* Room = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
			{
				Room->OnNotice.Broadcast(RideView == 0 ? FString(TEXT("Back in your seat."))
					: FString::Printf(TEXT("Looking %s. Hold the mouse button and move it to swing the camera, the wheel brings it nearer or further, and V moves on."), *Name));
			}
		}
		else if (PC->WasInputKeyJustPressed(EKeys::V))
		{
			CycleView();
		}
		if (RideView > 0)
		{
			if (PC->WasInputKeyJustPressed(EKeys::MouseScrollUp))
			{
				RideZoom = FMath::Clamp(RideZoom / ZoomStep, 0.4, 2.5);
			}
			if (PC->WasInputKeyJustPressed(EKeys::MouseScrollDown))
			{
				RideZoom = FMath::Clamp(RideZoom * ZoomStep, 0.4, 2.5);
			}
		}
		else if (bThirdPerson && !IsDriving())
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
	// -EWRideView=1 or 2 goes to the view from above (or from high up) as soon as the player is on something, for pictures.
	static const int32 TestRideView = []() { int32 Value = 0; FParse::Value(FCommandLine::Get(), TEXT("-EWRideView="), Value); return Value; }();
	if (TestRideView > 0 && !bRideViewTested && (Mount || bCarried))
	{
		bRideViewTested = true;
		SetRideView(TestRideView);
	}
	if (RideView > 0)
	{
		HoverTick(DeltaSeconds, PC);
	}
	else if (bThirdPerson && !IsDriving())
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
	Movement->MaxWalkSpeed = (bRunningNow ? RunSpeed : WalkSpeed) * (bPep ? 1.12f : 1.f); // full of beans
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
