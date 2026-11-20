#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "EarthWalkCharacter.generated.h"

class UCameraComponent;
class UEarthAnimalFigure;
class USpringArmComponent;

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
 *   Enter          chat and commands
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

private:
	void WaitForGround();
	bool TryLand();
	void ApplyView();

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

	bool bFlying = false;
	bool bWaitingForGround = true;
	bool bRunToggled = false;
	bool bRunningNow = false;

	/**
	 * Developer aids: -EWShot=<file.png> saves a screenshot a few seconds after landing, then quits;
	 * -EWView=0|1|2 starts in that camera view; -EWWalk makes the player walk forward by itself.
	 */
	FString ShotFile;
	float ShotCountdown = -1.f;
	bool bAutoWalk = false;
};
