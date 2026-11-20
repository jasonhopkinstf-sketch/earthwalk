#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthWorld.generated.h"

class AEarthChunkLabels;
class AEarthWalkAvatar;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class UProceduralMeshComponent;

/**
 * The generated world. Streams chunks from the world server around the local player,
 * converts between latitude/longitude and engine coordinates, and shows other people.
 *
 * Engine coordinates: +X is north, +Y is east, +Z is up, in centimetres. Z is height above
 * sea level. X/Y are measured from a movable origin (the last place the player teleported to),
 * so coordinates stay small wherever on Earth you are.
 */
UCLASS()
class AEarthWorld : public AActor
{
	GENERATED_BODY()

public:
	AEarthWorld();

	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

	static AEarthWorld* Get(const UObject* WorldContext);

	/** Re-centres the world on a place and throws away everything loaded for the old one. */
	void SetOrigin(double Lat, double Lon);

	FVector GeoToWorld(double Lat, double Lon, double AltMeters) const;
	void WorldToGeo(const FVector& Position, double& OutLat, double& OutLon, double& OutAltMeters) const;

	/** True once the chunk under this position has been received and built. */
	bool HasChunkAt(const FVector& Position) const;

	/** A lit, tinted instance of the basic engine material, shared by everything of that colour (0xRRGGBBAA). */
	UMaterialInstanceDynamic* MaterialFor(uint32 Rgba);

	/**
	 * The textured material for one of the server's surface ids (docs/PROTOCOL.md), tinted with its
	 * colour. Falls back to the plain tinted material until game\Tools\build-assets.cmd has been run.
	 */
	UMaterialInstanceDynamic* MaterialForSurface(uint32 SurfaceId, uint32 Rgba);

	/** Leafy or bark material for trees (instanced), tinted; Fluff 1 ruffles the normals for canopies. */
	UMaterialInstanceDynamic* MaterialForFoliage(uint32 Rgba, float Fluff);

	int32 NumLoadedChunks() const { return Chunks.Num(); }
	const FString& GetLastError() const { return LastError; }

private:
	void UpdateChunks(const FVector& Around);
	void RequestChunk(FIntPoint Key);
	bool BuildChunk(FIntPoint Key, const TArray<uint8>& Data);
	void UpdateLabels(FIntPoint Center);
	void RequestLabels(FIntPoint Key);
	void ClearLabels();
	void UpdateAvatars();
	FIntPoint ChunkAt(const FVector& Position) const;

	UPROPERTY()
	TMap<FIntPoint, TObjectPtr<UProceduralMeshComponent>> Chunks;

	UPROPERTY()
	TMap<FIntPoint, TObjectPtr<AEarthChunkLabels>> Labels;

	UPROPERTY()
	TMap<uint32, TObjectPtr<UMaterialInstanceDynamic>> Materials;

	UPROPERTY()
	TMap<uint64, TObjectPtr<UMaterialInstanceDynamic>> SurfaceMaterials;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> BaseMaterial;

	UPROPERTY()
	TMap<FString, TObjectPtr<AEarthWalkAvatar>> Avatars;

	TSet<FIntPoint> Pending;
	TMap<FIntPoint, double> RetryAfter;
	TSet<FIntPoint> PendingLabels;
	TMap<FIntPoint, double> LabelRetryAfter;
	FString LastError;

	double OriginX = 0.0; // tile coordinates of engine (0, 0)
	double OriginY = 0.0;
	double OriginLat = 0.0;
	double TileCm = 1.0; // engine units per chunk at the origin's latitude
	int32 Generation = 0; // bumped by SetOrigin so late replies for the old area are ignored
	float ChunkTimer = 0.f;
	float SendTimer = 0.f;
};
