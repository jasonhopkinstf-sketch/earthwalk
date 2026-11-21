#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthGroundCover.generated.h"

class AEarthWorld;
class UInstancedStaticMeshComponent;
class UMaterialInterface;
class UStaticMesh;

/**
 * The small things on the ground near the player: tufts of grass, patches of flowers, the odd stone.
 * They are not sent by the server. The world is cut into squares a few strides across, and each
 * square within reach of the player is planted from its own number, so a place looks the same every
 * time you come back to it; squares left behind are cleared away. What may grow where comes from
 * AEarthWorld::CoverAt (grass, forest floor, or something in the way such as a road or a house).
 */
UCLASS()
class AEarthGroundCover : public AActor
{
	GENERATED_BODY()

public:
	AEarthGroundCover();

	/** Plants the squares round this place that are not planted yet (a few each call) and clears distant ones. */
	void Update(AEarthWorld* World, const FVector& Around);

	/** Removes everything, for when the world is re-centred somewhere else. */
	void Clear();

	/** Takes up the squares a circle of ground reaches into, so the next Update plants them again (a herd has moved in). */
	void Replant(const FVector2D& Centre, double Radius);

private:
	using FParts = TArray<TWeakObjectPtr<UInstancedStaticMeshComponent>>;

	/** False when the ground there is not ready yet (its chunk, or the chunk's collision, has not arrived). */
	bool Plant(AEarthWorld* World, FIntPoint Square, double AroundZ, FParts& Parts);
	UInstancedStaticMeshComponent* AddPart(FParts& Parts, UStaticMesh* Mesh, UMaterialInterface* Material);

	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;

	TMap<FIntPoint, FParts> Squares;
};
