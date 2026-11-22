#pragma once

#include "CoreMinimal.h"
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
	/** How far above the ground under the player the seat is, in engine units: what other players are told, so the figure they see sits on top. */
	double SeatLiftCm() const;
	/** Being taken somewhere: the way to go (north and east, one unit long) and how much of the mount's pace to use. Cleared and set again each frame. */
	void SetAutopilot(const FVector2D& NorthEast, double Pace);
	void ClearAutopilot() { bAutopilot = false; }
	/** True while the player holds W, A, S or D. */
	bool IsSteering() const { return bSteering; }
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
	bool bCarried = false;
	bool bSteering = false;
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
