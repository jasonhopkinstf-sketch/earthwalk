#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "EarthWalkGameMode.generated.h"

/** Sets the scene up entirely in code: sky, sun, the generated world and the meetup connection. */
UCLASS()
class AEarthWalkGameMode : public AGameModeBase
{
	GENERATED_BODY()

public:
	AEarthWalkGameMode();

	virtual void InitGame(const FString& MapName, const FString& Options, FString& ErrorMessage) override;
	virtual void StartPlay() override;
};
