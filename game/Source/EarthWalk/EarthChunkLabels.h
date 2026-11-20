#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthChunkLabels.generated.h"

class AEarthWorld;
class FJsonValue;
class UMaterialInterface;
class UStaticMesh;

/**
 * The letterboxes and street signs of one chunk, built from the server's /v1/labels reply
 * (docs/PROTOCOL.md). One actor per chunk, destroyed together with the chunk.
 */
UCLASS()
class AEarthChunkLabels : public AActor
{
	GENERATED_BODY()

public:
	AEarthChunkLabels();

	/** ChunkOrigin is the chunk's north-west corner in engine units; TileCm is the chunk's size. */
	void Build(const TArray<TSharedPtr<FJsonValue>>& Items, const FVector& ChunkOrigin, double TileCm, AEarthWorld* World);

	int32 NumLabels() const { return Count; }

private:
	void AddBox(const FVector& Location, const FRotator& Rotation, const FVector& SizeCm, UMaterialInterface* Material);
	void AddText(const FString& Text, const FVector& Location, const FRotator& Rotation, float SizeCm, const FColor& Color);
	void AddPlate(const FString& Text, const FVector& Location, double Yaw, AEarthWorld* World);

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	int32 Count = 0;
};
