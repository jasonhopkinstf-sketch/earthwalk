#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthWorld.generated.h"

class AEarthChunkLabels;
class AEarthWalkAvatar;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class ACharacter;
class UProceduralMeshComponent;

/**
 * Which world is drawn. Generated is ours, built by the world server. Photo is Google's photographic
 * tiles instead of ours, walked on. Auto is ours on foot and the tiles from the air: both are loaded,
 * one is shown, and the player only ever stands on ours. See EarthPhotoWorld.h.
 */
enum class EEarthWorldKind : uint8
{
	Generated,
	Photo,
	Auto,
};

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

	/**
	 * True once there is ground to look for under this position: the chunk there has been received
	 * and built, or, in the photographic world, the tiles around the camera have (mostly) loaded.
	 * The photographic answer stays true once given, until the player is sent somewhere else: turning
	 * round asks for new tiles, and that must not freeze someone who is already walking.
	 */
	bool HasChunkAt(const FVector& Position) const;

	/**
	 * Chooses the kind of world. Returns false with a reason when a photographic kind cannot be shown
	 * (no plugin, no key). The change takes effect at the next SetOrigin, so callers follow it with a
	 * teleport to where the player is.
	 */
	bool SetWorldKind(EEarthWorldKind NewKind, FString& OutReason);
	EEarthWorldKind GetWorldKind() const { return WorldKind; }

	/** True in the kind where the tiles are the whole world and are walked on. */
	bool IsPhotoWorld() const { return WorldKind == EEarthWorldKind::Photo; }

	/** True while Google's tiles are what is on screen, in either photographic kind. */
	bool IsShowingPhoto() const { return WorldKind == EEarthWorldKind::Photo || bAerial; }

	/**
	 * True while the plugin may be drawing Google's credit line along the bottom of the screen: from the
	 * first fetch of tiles, and it stays up after the fetching pauses.
	 */
	bool IsPhotoCreditOnScreen() const { return PhotoTileset != nullptr; }

	/**
	 * In the photographic world: the engine Z of the ground at the origin, where a teleport puts the
	 * player. False until the tiles have answered, which takes a few seconds, and in the generated world.
	 */
	bool PhotoGroundAtOrigin(double& OutZ) const;

	/** The player has just been moved to where they will stand, so judge the tiles from there, from now. */
	void RestartPhotoWait();

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
	void UpdateAerial(const ACharacter* Player);
	void StartAerialAlignment();
	void SetAerial(bool bShowPhoto);
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

	/** The Cesium tileset of the photographic kinds, while there is one (EarthPhotoWorld.h). */
	UPROPERTY()
	TObjectPtr<AActor> PhotoTileset;

	EEarthWorldKind WorldKind = EEarthWorldKind::Generated;
	double PhotoSince = 0.0; // when the photographic world was last pointed at a new place
	mutable bool bPhotoReady = false; // HasChunkAt has said yes since then
	bool bPhotoGroundKnown = false;
	double PhotoGroundZ = 0.0;

	// Auto kind: the view from the air.
	bool bAerial = false; // the tiles are on screen and our own world is hidden
	bool bAerialSuspended = true; // the tileset is not fetching (the player is on or near the ground)
	bool bAerialAligned = false; // the tiles have been moved to our heights for this origin
	bool bAerialSampling = false;
	double AerialRetryAfter = 0.0;
	double AerialAboveSince = 0.0; // when the player last rose above the switching height

	TSet<FIntPoint> Pending;
	TMap<FIntPoint, double> RetryAfter;
	TSet<FIntPoint> PendingLabels;
	TMap<FIntPoint, double> LabelRetryAfter;
	FString LastError;

	double OriginX = 0.0; // tile coordinates of engine (0, 0)
	double OriginY = 0.0;
	double OriginLat = 0.0;
	double OriginLon = 0.0;
	double TileCm = 1.0; // engine units per chunk at the origin's latitude
	int32 Generation = 0; // bumped by SetOrigin so late replies for the old area are ignored
	float ChunkTimer = 0.f;
	float SendTimer = 0.f;
};
