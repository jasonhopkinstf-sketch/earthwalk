#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Character.h"
#include "EarthWalkCharacter.generated.h"

class UCameraComponent;

/**
 * The local player: first-person walking, with a fly mode for covering distance.
 *
 *   W A S D   move            Shift   go faster
 *   Mouse     look            Space   jump (walking) / rise (flying)
 *   F         toggle flying   C       descend (flying)
 *   Enter     chat and commands
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
	bool IsWaitingForGround() const { return bWaitingForGround; }

	/** While true (chat box open), movement keys are ignored. */
	bool bTyping = false;

private:
	void WaitForGround();
	bool TryLand();

	UPROPERTY()
	TObjectPtr<UCameraComponent> Camera;

	bool bFlying = false;
	bool bWaitingForGround = true;
};
