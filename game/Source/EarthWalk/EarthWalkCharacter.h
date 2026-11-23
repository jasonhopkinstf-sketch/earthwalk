#pragma once

#include "CoreMinimal.h"
#include "EarthMounts.h"
#include "GameFramework/Character.h"
#include "EarthWalkCharacter.generated.h"

class UCameraComponent;
class UEarthAnimalFigure;
class USpringArmComponent;
struct FEarthMount;

/** Where the camera sits. */
enum class EEarthView : uint8
{
	FirstPerson,
	Shoulder,
	Far,
};

/**
 * The local player: walking, with a fly mode for covering distance.
 *
 *   W A S D        move                 Shift (hold) or 2   run, 1 walk
 *   Left drag      look                 Left/Right arrows   turn, Up/Down tilt
 *   V              camera view          Mouse wheel         closer / further (third person)
 *   Space          jump (walking) / rise (flying)
 *   F              toggle flying        C                   descend (flying)
 *   E              hop on or off        T                   talk to what is nearest
 *   P              passport             Enter               chat and commands
 */
UCLASS()
class AEarthWalkCharacter : public ACharacter
{
	GENERATED_BODY()

public:
	AEarthWalkCharacter();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	/** Moves the player (and the world's origin) to a place on Earth. */
	void TeleportToGeo(double Lat, double Lon);

	void SetFlying(bool bFly);
	bool IsFlying() const { return bFlying; }
	bool IsRunning() const { return bRunningNow; }
	bool IsWaitingForGround() const { return bWaitingForGround; }

	/** First person, over the shoulder, far behind, then round again. */
	void CycleView();
	EEarthView GetView() const { return View; }

	/** Rebuilds the player's own figure from the saved animal choice. */
	void RefreshFigure();
	/** All five hearts are full today: a little quicker on foot (the server's `pep`; docs/PROTOCOL.md, "Food and hearts"). */
	void SetPep(bool bOn) { bPep = bOn; }
	/** Whoever is "it" at tag is a fifth quicker on foot, or nobody would ever be caught (EarthPlay.h). 1 for the usual pace. */
	void SetPlayBoost(float Times) { PlayBoost = Times; }

	/** While true (chat box open), movement and look keys are ignored. */
	bool bTyping = false;

	// ---- riding (UEarthCompany decides what; this is how the player moves while on it)

	/**
	 * On something that goes where the player steers it: it moves at the mount's pace (all of it with
	 * Shift, a little over half without), a boat keeps to water and everything else keeps off it, and
	 * the player's figure and eyes are raised to the seat. Null puts the player back on foot.
	 */
	void SetMount(const FEarthMount* InMount);
	const FEarthMount* GetMount() const { return Mount; }
	/** Carried by a train or by the friend who is steering: the player is put where that has got to, every frame. */
	void SetCarried(bool bInCarried);
	bool IsCarried() const { return bCarried; }
	/** Being flown to a place (EarthFlight.h): carried, but drawn stretched out to fly and not seated. */
	void SetFlown(bool bInFlown) { bFlown = bInFlown; }
	/**
	 * At the wheel of a car, a taxi or a tractor: W and S are the pedals, A and D the steering, Space
	 * the handbrake, and the camera sits behind the car, swung round by the mouse.
	 */
	bool IsDriving() const { return Mount && Mount->Top > 0.0; }
	const FEarthCar& GetCar() const { return Car; }
	/** The compass heading the player faces, in degrees: the way the car points when driving, else the way they look. */
	double FacingYaw() const;
	/** How far above the ground under the player the seat is, in engine units: what other players are told, so the figure they see sits on top. */
	double SeatLiftCm() const;
	/** Being taken somewhere: the way to go (north and east, one unit long) and how much of the mount's pace to use. Cleared and set again each frame. */
	void SetAutopilot(const FVector2D& NorthEast, double Pace);
	void ClearAutopilot() { bAutopilot = false; }
	/** True while the player holds W, A, S or D. */
	bool IsSteering() const { return bSteering; }
	/**
	 * The V key while riding or being carried (the view from above of server/public/js/player.js): from
	 * the seat to a camera hovering above and behind, then to one high up over the rooftops, then back.
	 * Returns the name of the view now in use ("from above"), or nothing when the player is on foot.
	 */
	FString NextRideView();
	int32 GetRideView() const { return RideView; }
	/** Where the soles of the player's feet are. */
	FVector FeetLocation() const;
	/** Puts the player's feet at a place, at once. */
	void PlaceFeetAt(const FVector& Feet);

private:
	void WaitForGround();
	bool TryLand();
	void ParkAtPhotoGround();
	void ApplyView();
	void ApplySeat();
	void RideTick(float DeltaSeconds, APlayerController* PC);
	void DriveTick(float DeltaSeconds, APlayerController* PC, float Throttle, float Steer, bool bHandbrake, bool bAuto);
	void ApplyDriveView();
	void SetDriveFriction(bool bDriving);
	void SetRideView(int32 NewView);
	void HoverTick(float DeltaSeconds, APlayerController* PC);
	/** True while something else is taking the player along: a train, a friend, or a mount finding its own way. */
	bool IsTaken() const { return bCarried || (Mount && bAutopilot && !bSteering); }

	// The view from above: which (0 the seat, 1 from above, 2 from high up), nearer or further by the wheel,
	// how far round from behind the camera has been swung and how much lower or higher than usual (degrees),
	// the way the ride has been going, and the tilt in use now (steeper where a building is in the way).
	int32 RideView = 0;
	double RideZoom = 1.0;
	double RideOrbit = 0.0;
	double RideLift = 0.0;
	double RideCourse = 0.0;
	double RideTiltNow = 0.0;
	bool bRideDrift = false; // circling slowly by itself, until the mouse says where to look
	bool bRideViewTested = false;
	FVector RideWas = FVector::ZeroVector;

	UPROPERTY()
	TObjectPtr<USpringArmComponent> Boom;

	UPROPERTY()
	TObjectPtr<UCameraComponent> Camera;

	UPROPERTY()
	TObjectPtr<UEarthAnimalFigure> Figure;

	EEarthView View = EEarthView::FirstPerson;
	float ShoulderDistance = 250.f;
	float FarDistance = 700.f;
	float ArmTarget = 0.f;
	float FigureYaw = 0.f; // which way the figure faced a frame ago, to tell how fast it is turning

	bool bFlying = false;
	bool bWaitingForGround = true;
	bool bParkedAtPhotoGround = false;
	bool bRunToggled = false;
	bool bRunningNow = false;

	const FEarthMount* Mount = nullptr;
	FEarthCar Car;
	bool bHasWant = false; // the velocity asked for last frame, to tell when a wall took some of it
	double WantVx = 0.0;
	double WantVz = 0.0;
	bool bDriveFriction = false;
	bool bCarried = false;
	bool bFlown = false;
	float PlayBoost = 1.f;
	bool bSteering = false;
	bool bPep = false;
	bool bAutopilot = false;
	FVector2D AutoNorthEast = FVector2D::ZeroVector;
	double AutoPace = 0.0;
	bool bHasGoodSpot = false; // the last place the mount was allowed to be: off the water, or on it for a boat
	FVector GoodSpot = FVector::ZeroVector;

	/**
	 * Developer aids: -EWShot=<file.png> saves a screenshot a few seconds after landing, then quits;
	 * -EWView=0|1|2 starts in that camera view; -EWWalk makes the player walk forward by itself;
	 * -EWYaw=<compass degrees> and -EWPitch=<degrees> set where the player looks at the start;
	 * -EWShotUI keeps the on-screen text (chat, credits) in the screenshot; -EWShotDelay=<seconds>
	 * waits that long after landing (8 by default); -EWFly=<metres> starts flying that far above the
	 * ground. While a screenshot is pending the keyboard and mouse are ignored, so typing in another
	 * window cannot move the player.
	 */
	FString ShotFile;
	float ShotCountdown = -1.f;
	float ShotDelay = 8.f;
	float StartFlyMeters = 0.f;
	bool bHandsOff = false;
	bool bAutoWalk = false;
	bool bShotWithUI = false;
	bool bStartLookPending = false;
	FRotator StartLook = FRotator::ZeroRotator;
};
