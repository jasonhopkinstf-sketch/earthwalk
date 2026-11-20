#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthWalkAvatar.generated.h"

class UStaticMeshComponent;
class UTextRenderComponent;

/** How another person appears in the world: a simple figure with their name above it. */
UCLASS()
class AEarthWalkAvatar : public AActor
{
	GENERATED_BODY()

public:
	AEarthWalkAvatar();

	virtual void Tick(float DeltaSeconds) override;

	void SetDisplayName(const FString& Name);

	/** Where the person's feet are now; the figure glides there. */
	void SetTarget(const FVector& FeetLocation, double YawDegrees);

private:
	UPROPERTY()
	TObjectPtr<UStaticMeshComponent> Body;

	UPROPERTY()
	TObjectPtr<UStaticMeshComponent> Head;

	UPROPERTY()
	TObjectPtr<UTextRenderComponent> Label;

	FVector TargetLocation = FVector::ZeroVector;
	double TargetYaw = 0.0;
};
