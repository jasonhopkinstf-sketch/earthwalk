#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "EarthRaceCourse.generated.h"

class AEarthWorld;
class UInstancedStaticMeshComponent;
class UStaticMesh;
class UStaticMeshComponent;
struct FEarthRace;

/**
 * The gates of a race, stood along the road (docs/PROTOCOL.md, "Races"): two posts and a banner of
 * squares across the top, green for the start, orange on the way and chequered black for the finish,
 * going grey as this player passes them, with a beacon over the one to go through next. The Windows
 * counterpart of the gates in server/public/js/race.js.
 */
UCLASS()
class AEarthRaceCourse : public AActor
{
	GENERATED_BODY()

public:
	AEarthRaceCourse();

	/**
	 * Stands the gates of a race up afresh. MyGate is how many this player has passed (-1 when they are
	 * not running); bBeacon lights the next one. Returns how many gates could be placed: the ground under
	 * the rest has not arrived yet, so the caller tries again.
	 */
	int32 Rebuild(AEarthWorld* World, const FEarthRace& Race, int32 MyGate, bool bBeacon);

private:
	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	/** Cubes, one component a colour: posts and pale squares, start, gate, finish, and the two greys of a gate passed. */
	UPROPERTY()
	TArray<TObjectPtr<UInstancedStaticMeshComponent>> Paints;

	UPROPERTY()
	TObjectPtr<UStaticMeshComponent> Beacon;
};
