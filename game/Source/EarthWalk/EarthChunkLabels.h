#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthChunkLabels.generated.h"

class AEarthWorld;
class FJsonValue;
class UInstancedStaticMeshComponent;
class UMaterialInterface;
class UStaticMesh;

/**
 * The trees, letterboxes and street signs of one chunk, built from the server's /v1/labels reply
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
	int32 NumTrees() const { return Trees; }

private:
	void AddBox(const FVector& Location, const FRotator& Rotation, const FVector& SizeCm, UMaterialInterface* Material);
	void AddText(const FString& Text, const FVector& Location, const FRotator& Rotation, float SizeCm, const FColor& Color);
	void AddPlate(const FString& Text, const FVector& Location, double Yaw, AEarthWorld* World);
	void AddTree(const FVector& Base, double Yaw, double HeightM, double RadiusM, bool bConifer, uint32 Seed, AEarthWorld* World);
	UInstancedStaticMeshComponent* Blobs(uint32 Color, AEarthWorld* World);
	UInstancedStaticMeshComponent* Cones(uint32 Color, AEarthWorld* World);
	UInstancedStaticMeshComponent* Instanced(TObjectPtr<UInstancedStaticMeshComponent>& Slot, UStaticMesh* Mesh, UMaterialInterface* Material, bool bCollide);

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;

	UPROPERTY()
	TObjectPtr<UInstancedStaticMeshComponent> Trunks;

	/** Leafy spheres and needle cones, one component to each colour of leaf, blossom or fruit. */
	UPROPERTY()
	TMap<uint32, TObjectPtr<UInstancedStaticMeshComponent>> BlobParts;

	UPROPERTY()
	TMap<uint32, TObjectPtr<UInstancedStaticMeshComponent>> ConeParts;

	int32 Count = 0;
	int32 Trees = 0;
};
