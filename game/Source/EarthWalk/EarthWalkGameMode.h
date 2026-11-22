#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "EarthWalkGameMode.generated.h"

class UMaterialInstanceDynamic;

/** Sets the scene up entirely in code: sky, sun, the generated world and the meetup connection. */
UCLASS()
class AEarthWalkGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AEarthWalkGameMode();

	virtual void InitGame(const FString& MapName, const FString& Options, FString& ErrorMessage) override;
	virtual void StartPlay() override;

	/** Sets the ink pass for the look in use (EarthLook.h); /look calls it. */
	void ApplyLook();

private:
	/** M_EarthInk over the whole view, or null when the outlines are off or the art has not been built. */
	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> Ink;

	/** The whole-view volume the ink sits in; the flat look also takes the lens's dark corners off through it. */
	UPROPERTY()
	TObjectPtr<class APostProcessVolume> LookVolume;
};
