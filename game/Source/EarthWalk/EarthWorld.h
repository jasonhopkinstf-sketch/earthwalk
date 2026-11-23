#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Templates/Function.h"
#include "EarthWorld.generated.h"

class AEarthChunkLabels;
class AEarthGroundCover;
class AEarthLife;
class AEarthWalkAvatar;
class UEarthCompany;
class UEarthShowcase;
class UMaterialInstanceDynamic;
class UMaterialInterface;
class ACharacter;
class UProceduralMeshComponent;

/**
 * Which world is drawn. Generated is ours, built by the world server. Photo is Google's photographic
 * tiles instead of ours, walked on. Auto is ours on foot and the tiles from the air: both are loaded,
 * one is shown, and the player only ever stands on ours. See EarthPhotoWorld.h.
 */
/** A front door that opens (a labels item of kind "door"; docs/PROTOCOL.md, "Inside houses"). */
struct FEarthDoor
{
	FIntPoint Chunk = FIntPoint::ZeroValue;
	int64 Id = 0;     // the building
	double X = 0.0;   // metres east of the world's origin
	double Z = 0.0;   // metres south of it
	double H = 0.0;   // the height of the floor inside, metres above sea level
	double Yaw = 0.0; // the compass heading out of the door, in degrees
	FString Use;      // "shop", "cafe", "office" or "lobby" when this is a small shop or the like, which opens as a house does but is nobody's to live in; empty for a house
};

/** A shop or somewhere to eat with its name on a board (a labels item of kind "sign" with a `use`; docs/PROTOCOL.md, "Food and hearts"). */
struct FEarthShop
{
	FIntPoint Chunk = FIntPoint::ZeroValue;
	double X = 0.0; // metres east of the world's origin
	double Z = 0.0; // metres south of it
	FString Text;   // its name, as on the board
	FString Use;    // "shop" or "food"
};

/** What covers a square metre of ground, as far as planting tufts and flowers on it goes (AEarthWorld::CoverAt). */
namespace EarthCover
{
	constexpr uint8 Unknown = 0; // no chunk there yet
	constexpr uint8 Grass = 1; // meadow, parks, lawns
	constexpr uint8 Forest = 2;
	constexpr uint8 Farm = 3;
	constexpr uint8 Edge = 254; // beside something in the way
	constexpr uint8 Blocked = 255; // a road, path, building, water, sand, rock...
}

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

	/** What covers the ground at a place: one of EarthCover. Built with each chunk, a cell to about a metre. */
	uint8 CoverAt(const FVector& Position) const;

	/**
	 * Height of the terrain in metres above sea level at a place given in metres east and south of the
	 * origin; false while that chunk has not arrived. This is the bare ground (no roofs, roads or trees),
	 * the same surface the browser game stands its animals on.
	 */
	bool TerrainHeightAt(double EastM, double SouthM, double& OutMeters) const;

	/** Where herds roam and tractors work near a square of ground (AEarthLife::HomeCirclesIn): crops keep off. */
	void HomeCirclesIn(const FBox2D& Area, TArray<FVector>& OutCentreAndRadius) const;

	/**
	 * Is this spot open water (the ground boats sail on)? False while that chunk has not arrived;
	 * otherwise bOutWet says. A cell is about ten metres, as in the browser game.
	 */
	bool WaterAt(double EastM, double SouthM, bool& bOutWet) const;
	AEarthLife* GetLife() const { return Life; }
	/** The front doors that open within reach of a spot (metres east and south of the origin). */
	void DoorsNear(double EastM, double SouthM, double ReachM, TArray<FEarthDoor>& Out) const;
	/** The shops and places to eat within reach of a spot: food is bought beside one. */
	void ShopsNear(double EastM, double SouthM, double ReachM, TArray<FEarthShop>& Out) const;
	/**
	 * Makes the inside of a house ready to walk into: fetched from the server and built the first time
	 * somebody goes in, and kept with its chunk after that. Done is told whether it is, and why not.
	 */
	void OpenHouse(const FEarthDoor& Door, TFunction<void(bool bOpen, const FString& Why)> Done);
	/** How many times the house behind a door has been changed by whoever lives in it (0 for one nobody lives in). */
	int64 HouseRev(const FEarthDoor& Door) const;
	/** Riding, talking and telling things what to do (EarthCompany.h). */
	UEarthCompany* GetCompany() const { return Company; }
	/** "Show me...": the list of things to show somebody, and the going to them (EarthShowcase.h). */
	UEarthShowcase* GetShowcase() const { return Showcase; }
	/** True once the animals, cars, doors and trains of the chunk under a position have arrived: they come a moment after the ground does. */
	bool HasLabelsAt(const FVector& Position) const { return Labels.Contains(ChunkAt(Position)); }
	/** The figure of someone else in the room, by their id; null when this game is not showing them. */
	AEarthWalkAvatar* FindAvatar(const FString& Id) const;

	/** A lit, tinted instance of the basic engine material, shared by everything of that colour (0xRRGGBBAA). */
	UMaterialInstanceDynamic* MaterialFor(uint32 Rgba);

	/**
	 * The textured material for one of the server's surface ids (docs/PROTOCOL.md), tinted with its
	 * colour. Falls back to the plain tinted material until game\Tools\build-assets.cmd has been run.
	 */
	UMaterialInstanceDynamic* MaterialForSurface(uint32 SurfaceId, uint32 Rgba);

	/**
	 * Leafy or bark material for trees and plants (instanced), tinted; Fluff 1 ruffles the normals for
	 * canopies, and SwayCm is how far the top of each shape moves in the wind (0 for trunks and stones).
	 * bSmall is for things a hand's width across (tufts, flowers, crops): the flat look draws no line round them.
	 */
	UMaterialInstanceDynamic* MaterialForFoliage(uint32 Rgba, float Fluff, int32 SwayCm = 0, bool bSmall = false);

	/** Repaints every material already made for the look in use (EarthLook.h); /look calls it. */
	void ApplyLook();

	int32 NumLoadedChunks() const { return Chunks.Num(); }
	const FString& GetLastError() const { return LastError; }

private:
	void UpdateChunks(const FVector& Around);
	void RequestChunk(FIntPoint Key);
	bool BuildChunk(FIntPoint Key, const TArray<uint8>& Data);
	bool BuildInterior(FIntPoint Key, int64 Id, const TArray<uint8>& Data);
	void ForgetInteriors(FIntPoint Key);
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

	UPROPERTY()
	TObjectPtr<AEarthGroundCover> GroundCover;

	/** Animals, cars and trains (EarthLife.h). */
	UPROPERTY()
	TObjectPtr<AEarthLife> Life;

	UPROPERTY()
	TObjectPtr<UEarthCompany> Company;

	UPROPERTY()
	TObjectPtr<UEarthShowcase> Showcase;

	/** The insides of houses somebody has gone into, by "chunk x/chunk y/building". They leave with their chunk. */
	UPROPERTY()
	TMap<FString, TObjectPtr<UProceduralMeshComponent>> Interiors;
	TMap<FIntPoint, TArray<FEarthDoor>> Doors;
	TMap<FIntPoint, TArray<FEarthShop>> Shops;
	/** Which furnishing each inside that is built shows: a house somebody lives in is fetched again when they change it. */
	TMap<FString, int64> InteriorRevs;

	/** Per chunk, which cells of the terrain (TerrainGrid a side) are water, row by row from the north-west corner. */
	TMap<FIntPoint, TArray<uint8>> WaterMaps;

	/** Per chunk, CoverCells x CoverCells of EarthCover, row by row from the north-west corner. */
	TMap<FIntPoint, TArray<uint8>> CoverMaps;

	/** Per chunk, the terrain's heights in metres on a lattice of TerrainGrid + 1 points a side, as the browser keeps them. */
	TMap<FIntPoint, TArray<float>> HeightMaps;

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
