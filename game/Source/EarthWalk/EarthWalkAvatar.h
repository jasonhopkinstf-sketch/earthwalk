#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthWalkAvatar.generated.h"

class UEarthAnimalFigure;
class UTextRenderComponent;

/** How another person appears in the world: their animal with their name above it. */
UCLASS()
class AEarthWalkAvatar : public AActor
{
	GENERATED_BODY()

public:
	AEarthWalkAvatar();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;

	void SetDisplayName(const FString& Name);

	/** Which animal they chose (fox, bear, rabbit, cat, owl or frog). */
	void SetAnimal(const FString& Id);

	/** Where the person's feet are now; the figure glides there. */
	void SetTarget(const FVector& FeetLocation, double YawDegrees);

	/** Scale applied to the 1.4 m browser figure so it matches the player's capsule. */
	static constexpr double FigureScale = 1.2;

private:
	UPROPERTY()
	TObjectPtr<UEarthAnimalFigure> Figure;

	UPROPERTY()
	TObjectPtr<UTextRenderComponent> Label;

	FVector TargetLocation = FVector::ZeroVector;
	double TargetYaw = 0.0;
};
