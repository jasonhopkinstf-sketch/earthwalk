#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthTreasure.generated.h"

class AEarthWorld;
class UStaticMesh;
class UStaticMeshComponent;

/**
 * The treasure at the end of a treasure hunt (docs/PROTOCOL.md, "Treasure hunts and expeditions").
 * The server says where it was found; a chest stands there for a minute, its lid up and its coins
 * turning, for the finder to look at. The Windows counterpart of server/public/js/treasure.js.
 */
UCLASS()
class AEarthTreasure : public AActor
{
	GENERATED_BODY()

public:
	AEarthTreasure();

	virtual void Tick(float DeltaSeconds) override;

	/** Builds the chest in the world's own paints. Its front, where the lock is, is the actor's +X. */
	void Build(AEarthWorld* World);

private:
	UStaticMeshComponent* AddPart(USceneComponent* Parent, bool bCoin, uint32 Hex, const FVector& Scale, const FVector& Position, AEarthWorld* World);

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY()
	TArray<TObjectPtr<UStaticMeshComponent>> Coins;

	float Age = 0.f;
};
