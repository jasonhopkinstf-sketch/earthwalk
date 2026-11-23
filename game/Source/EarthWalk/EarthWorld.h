#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "Templates/Function.h"
#include "EarthWorld.generated.h"

class AEarthChunkLabels;
class AEarthGroundCover;
class AEarthLife;
class AEarthInside;
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
	FString Use;      // "shop", "cafe", "office", "mall", "lobby", "church", "school", "hospital", "factory"... (UseWords) when this is a shop or the like, which opens as a house does but is nobody's to live in; empty for a house
	FString Text;     // what the building is called, where the map says (on the first of its doors)
	bool bEntry = false; // a labels item of kind "entry": a door of a shop, an office, a mall... (docs/PROTOCOL.md, "Inside other buildings")
	double G = 0.0;   // the ground outside the door, metres above sea level
	// The door inside, on the wall of the room: where the door outside is, unless the room is a few steps from it.
	double Ix = 0.0;
	double Iz = 0.0;
	double IYaw = 0.0;

	/**
	 * The words for a kind of building that is not a house (the `use` of its door, docs/PROTOCOL.md, "Inside other
	 * buildings"): 0 what goes on the board over a door with no name ("CHURCH"), 1 what it is called in a hint
	 * ("the church"), 2 what it is ("a church"). The browser's are PLACE_WORDS in world.js and PLACE_TITLES in
	 * houses.js: keep them in step. Empty for a use this game does not know (board: "COME IN").
	 */
	static FString UseWords(const FString& InUse, int32 Which)
	{
		struct FRow { const TCHAR* Use; const TCHAR* Board; const TCHAR* The; const TCHAR* A; };
		static const FRow Rows[] = {
			{ TEXT("office"), TEXT("OFFICE"), TEXT("the office"), TEXT("an office") },
			{ TEXT("shop"), TEXT("SHOP"), TEXT("the shop"), TEXT("a shop") },
			{ TEXT("cafe"), TEXT("CAF\u00c9"), TEXT("the caf\u00e9"), TEXT("a caf\u00e9") },
			{ TEXT("mall"), TEXT("SHOPS"), TEXT("the shops"), TEXT("a row of shops") },
			{ TEXT("lobby"), TEXT("COME IN"), TEXT("the entrance hall"), TEXT("an entrance hall") },
			{ TEXT("church"), TEXT("CHURCH"), TEXT("the church"), TEXT("a church") },
			{ TEXT("mosque"), TEXT("MOSQUE"), TEXT("the mosque"), TEXT("a mosque") },
			{ TEXT("temple"), TEXT("TEMPLE"), TEXT("the temple"), TEXT("a temple") },
			{ TEXT("school"), TEXT("SCHOOL"), TEXT("the school"), TEXT("a school") },
			{ TEXT("hospital"), TEXT("HOSPITAL"), TEXT("the hospital"), TEXT("a hospital") },
			{ TEXT("clinic"), TEXT("CLINIC"), TEXT("the clinic"), TEXT("a clinic") },
			{ TEXT("factory"), TEXT("FACTORY"), TEXT("the factory"), TEXT("a factory") },
			{ TEXT("warehouse"), TEXT("WAREHOUSE"), TEXT("the warehouse"), TEXT("a warehouse") },
			{ TEXT("fuel"), TEXT("PETROL"), TEXT("the petrol station"), TEXT("a petrol station") },
		};
		for (const FRow& Row : Rows)
		{
			if (InUse == Row.Use)
			{
				return Which == 0 ? Row.Board : Which == 1 ? Row.The : Row.A;
			}
		}
		return FString();
	}
	/** What to call the building: its name, or what it is ("the office"). Empty for a house. */
	FString Called() const
	{
		return !Text.IsEmpty() ? Text : UseWords(Use, 1);
	}
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
	/** Bumped whenever the world's origin moves: something that began before a move can tell. */
	int32 GetGeneration() const { return Generation; }
	/** A chunk's size at the origin's latitude, in metres. */
	double TileMeters() const { return TileCm / 100.0; }
	/**
	 * A flight is on (EarthFlight.h), or over. With bFocus the world is asked for round Focus and not round
	 * the player; with bGeo the room is told the flyer is at Lat, Lon, which is where they really are while
	 * the scene cannot say (crossing in the haze). While it is on every position sent says "flown", so the
	 * server counts none of it as walking and downloads no map ahead of it.
	 */
	void SetFlight(bool bOn, bool bFocus, const FVector& Focus, bool bGeo, double Lat, double Lon);
	/** Every door of the building a door belongs to (one or two), each with the building's name on it. */
	void DoorsOf(const FEarthDoor& Door, TArray<FEarthDoor>& Out) const;
	/** The shops and places to eat within reach of a spot: food is bought beside one. */
	void ShopsNear(double EastM, double SouthM, double ReachM, TArray<FEarthShop>& Out) const;
	/**
	 * Makes the inside of a house ready to walk into: fetched from the server and built the first time
	 * somebody goes in, and kept with its chunk after that. Done is told whether it is, and why not.
	 */
	void OpenHouse(const FEarthDoor& Door, TFunction<void(bool bOpen, const FString& Why)> Done);
	/**
	 * How far above its real door the inside of a house stands, in metres: nothing, but for a house built
	 * from its owner's own floor plan, whose rooms are at their true size and so cannot go inside the real
	 * walls (docs/PROTOCOL.md, "A plan of one's own"). Whoever goes in at the door is put on its floor up there.
	 */
	double HouseLift(const FEarthDoor& Door) const;
	/**
	 * Who is inside the shop, office or mall behind a door, what is lettered on its walls and where food is
	 * sold in it: asked of the server and shown (EarthInside.h). For the one building the player is in.
	 */
	void OpenInside(const FEarthDoor& Door);
	void CloseInside();
	AEarthInside* GetInside() const { return Inside; }
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
	TObjectPtr<AEarthInside> Inside;
	/** The building whose people were last asked for ("x/y/id"): an answer for any other is not shown. */
	FString InsideWanted;

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
	bool bFlightOn = false;
	bool bFlightFocus = false;
	FVector FlightFocus = FVector::ZeroVector;
	bool bFlightGeo = false;
	double FlightLat = 0.0;
	double FlightLon = 0.0;
	int32 Generation = 0; // bumped by SetOrigin so late replies for the old area are ignored
	float ChunkTimer = 0.f;
	float SendTimer = 0.f;
};
