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

	/** The drawn line round everything, on or off (/lines; kept as Lines). Off is easier on a slow computer. */
	void SetLines(bool bOn);
	bool LinesOn() const { return bLines; }

	/**
	 * The hour and the weather, for the whole view (UEarthWeather): the drawn line is lost in a fog as the land is
	 * (it was otherwise drawn round every house behind it), and the night is shown a little darker than the day,
	 * which the engine's eye for light would otherwise undo. Mist and Night are 0 to 1; the haze begins NearM off and is whole by FarM.
	 * Hour is the tint of the hour, which the flat look is given whole: it takes no light, and its night was as bright as its noon.
	 */
	void SetAir(double Mist, double NearM, double FarM, double Night, const FLinearColor& Hour);

private:
	/** M_EarthInk over the whole view, or null when the outlines are off or the art has not been built. */
	UPROPERTY()
	TObjectPtr<UMaterialInstanceDynamic> Ink;

	/** The whole-view volume the ink sits in; the flat look also takes the lens's dark corners off through it. */
	UPROPERTY()
	TObjectPtr<class APostProcessVolume> LookVolume;
	bool bLines = true;
	double AirMist = -1.0;
};
