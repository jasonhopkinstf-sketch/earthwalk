#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthWorld.h"
#include "EarthInside.generated.h"

class FJsonObject;
class UEarthAnimalFigure;
class UMaterialInterface;
class UStaticMesh;

/** Somebody inside a shop, a café, an office, a mall or an entrance hall (docs/PROTOCOL.md, "Inside other buildings"). */
struct FEarthIndoorPerson
{
	uint32 Id = 0;  // the same every visit: what a player talks to
	FString Sp;     // fox, bear, rabbit, cat, owl or frog
	FString Role;   // worker, meeting, reception, keeper, barista, shopper, guest, caretaker, resident
	int32 Pose = 0; // 0 standing, 1 sitting, 2 strolling a path there and back
	double X = 0.0; // where they are now: metres east and south of the world's origin
	double Z = 0.0;
	double H = 0.0; // the floor, metres above sea level
	double Yaw = 0.0;  // the compass heading they face, as the server gave it
	double Seat = 0.0; // sitting: how high the seat is above the floor
	TArray<FVector2D> Path; // strolling: the way, as east and south
	double Length = 0.0;
	double Facing = 0.0; // the heading drawn just now
	bool bWalking = false;
	UEarthAnimalFigure* Figure = nullptr;
};

/**
 * Who is inside the building the player has gone into, what is lettered on its walls, and where food
 * is sold in it: the answer to GET /v1/inside. One actor, for the one building the player is in; the
 * world makes it on the way in and takes it away on the way out (AEarthWorld::OpenInside, CloseInside).
 *
 * The animals are the six a player can be, drawn with the player's own figure: seated, standing (one
 * turns to face a player who comes close, and back afterwards) or strolling a path by the shared
 * clock, so that everybody sees a stroller in the same place (strollAt in server/public/js/peoplemotion.js).
 */
UCLASS()
class AEarthInside : public AActor
{
	GENERATED_BODY()

public:
	AEarthInside();

	/** OriginX and OriginY are the tile coordinates of the world's origin, TileM a chunk's size in metres there. */
	void Build(const FJsonObject& Json, FIntPoint InChunk, int64 InId, double OriginX, double OriginY, double TileM, AEarthWorld* World);
	virtual void Tick(float DeltaSeconds) override;

	const TArray<FEarthIndoorPerson>& GetPeople() const { return People; }
	const FEarthIndoorPerson* FindPerson(uint32 PersonId) const;
	/** Where food is sold inside: within reach of one the lunch box shows what the place sells. */
	const TArray<FEarthShop>& GetTills() const { return Tills; }
	FIntPoint GetChunk() const { return Chunk; }
	int64 GetBuilding() const { return Building; }
	/** The room from corner to corner, in metres. */
	double GetSize() const { return Size; }

private:
	void AddBoard(const FString& Text, const FVector& At, double Yaw, double WidthM, AEarthWorld* World);

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TArray<TObjectPtr<UEarthAnimalFigure>> Figures;

	TArray<FEarthIndoorPerson> People;
	TArray<FEarthShop> Tills;
	FIntPoint Chunk = FIntPoint::ZeroValue;
	int64 Building = 0;
	double Size = 50.0;
};
