#pragma once

#include "CoreMinimal.h"
#include "EarthLifeMotion.h"
#include "EarthLifeRigs.h"
#include "EarthMounts.h"
#include "GameFramework/Actor.h"
#include "EarthLife.generated.h"

class AEarthWorld;
class FJsonValue;
class UEarthSounds;
class UInstancedStaticMeshComponent;
class UMaterialInterface;
class UStaticMesh;

/** Somewhere to stand a player beside a thing (UEarthShowcase): where the thing is, in metres east and south of the origin. */
struct FEarthSpot
{
	double X = 0.0;
	double Z = 0.0;
	FString Sp;
	double R = 4.0;        // a home: how far its animals roam
	double Yaw = 0.0;      // a parked car or a door: its compass heading, in degrees
	double Heading = 0.0;  // a train: the compass way the track runs there
	double In = 0.0;       // a train: how many seconds until its middle is there
	bool bPassing = false; // a train: it goes by without stopping
};

/**
 * The living world: farm animals, ducks, birds, pets and wild creatures, tractors and boats, cars
 * parked and on their trips, and trains, wherever the server's labels say one lives (docs/PROTOCOL.md,
 * "Life", "Traffic", "Trains"). Where each is comes from EarthLifeMotion and the shared clock, so
 * everyone in a room, in this game or the browser, sees the same animal in the same place. What happens
 * when a player comes close (a look, a step aside, a dog trotting over, pigeons taking off, a car
 * stopping to toot) is worked out here from the player positions we already have. It is the Windows
 * counterpart of server/public/js/life.js and traffic.js, and follows them line for line.
 *
 * Everything is drawn with four instanced meshes, one per basic shape, whatever the number of
 * animals; each instance carries its own colour (M_EarthFigure). Ink outlines come from M_EarthInk.
 */
UCLASS()
class AEarthLife : public AActor
{
	GENERATED_BODY()

public:
	AEarthLife();

	/**
	 * Takes the homes, cars, trips and trains out of one chunk's labels. OriginX/Y are the tile
	 * coordinates of engine (0, 0) and TileM the size of a chunk in metres there.
	 */
	void AddChunk(FIntPoint Key, const TArray<TSharedPtr<FJsonValue>>& Items, double OriginX, double OriginY, double TileM);
	void RemoveChunk(FIntPoint Key);
	void Clear();

	/**
	 * Every frame. SharedTime is the room's clock in seconds; Players are where everyone's feet are
	 * in engine units, this player first; Ears is where the camera is.
	 */
	void Update(const AEarthWorld* World, float DeltaSeconds, double SharedTime, const TArray<FVector>& Players, const FVector& Ears);

	/**
	 * Where herds roam and tractors work, so crops can be kept off that ground: the circles that reach
	 * into a square of ground, each as centre X, centre Y and radius in engine units.
	 */
	void HomeCirclesIn(const FBox2D& Area, TArray<FVector>& OutCentreAndRadius) const;
	/** The same, for the homes that came with one chunk: the ground round them is replanted when they arrive. */
	void HomeCircles(FIntPoint Key, TArray<FVector>& OutCentreAndRadius) const;

	/** The animals within sixty metres as last drawn, for talking to; and everything near enough to think of riding. */
	const TArray<FEarthThing>& GetNearby() const { return Nearby; }
	const TArray<FEarthThing>& GetRideable() const { return Rideable; }
	/**
	 * Before Update: the identities that are not where their timetable has them (ridden, left standing
	 * or told what to do), and where to draw each of those instead.
	 */
	void SetOutOfPlace(const TSet<uint32>& InHidden, const TArray<FEarthThing>& InMounts) { Taken = InHidden; Mounts = InMounts; }
	/** Where carriage K of a train is at shared time T, for a passenger on its roof (X, Y, Z and Yaw of Out); false if this game does not have the train. */
	bool CarriageAt(const AEarthWorld* World, uint32 Id, int32 K, double T, FEarthThing& Out) const;
	/** A thing that is being talked to speaks up in its own voice as well, if it has one. */
	void Speak(const AEarthWorld* World, const FString& Sp, uint32 Thing, double X, double Z);
	/** The trees and houses within eight metres of a spot (metres east and south of the origin): they can be talked to. */
	void FixedNear(double X, double Z, TArray<FEarthThing>& Out) const;

	// ---- for "Show me" (UEarthShowcase; boarding and soonest of server/public/js/traffic.js). All of
	// these look through every chunk this game holds, not only what is near enough to be drawn.

	/**
	 * Where to stand to catch a train near a spot: for each train that comes within Reach metres of it,
	 * the first moment from shared time T on when it stands still there for a good while (at a station,
	 * or at an end of its run); or, if it does not within Within seconds, the next time it passes the
	 * nearest point of its track, marked bPassing.
	 */
	void Boarding(double T, double FromX, double FromZ, double Reach, TArray<FEarthSpot>& Out, double Within = 90.0) const;
	/**
	 * Where to go to meet each train soonest, wherever on its run that is: where it will be standing
	 * still within Wait seconds, or failing that where it will be Lead seconds from now.
	 */
	void Soonest(double T, TArray<FEarthSpot>& Out, double Wait = 30.0, double Lead = 20.0) const;
	/** The nearest home of one of these kinds of animal (or machine) to a spot, within so many metres. */
	bool NearestHome(const TArray<FString>& Kinds, double FromX, double FromZ, double Within, FEarthSpot& Out) const;
	/** The nearest parked car that nobody has driven off. */
	bool NearestParked(double FromX, double FromZ, double Within, FEarthSpot& Out) const;
	/** Every parked car within so many metres that nobody has driven off, for the little map. */
	void ParkedNear(double FromX, double FromZ, double Within, TArray<FEarthSpot>& Out) const;
	/** Every place within so many metres where a train stands for a while, whenever that is: its stations and the ends of its run. */
	void StopsNear(double FromX, double FromZ, double Within, TArray<FEarthSpot>& Out) const;

	UEarthSounds* GetSounds() const { return Sounds; }
	int32 NumShown() const { return Shown; }

private:
	struct FHerd
	{
		EarthLife::FHome Home;
		const FEarthRig* Rig = nullptr;
		double H = 0.0; // ground height at the home's centre, metres
		double X = 0.0; // metres east of the world's origin
		double Z = 0.0; // metres south of it
		double D = 0.0; // how far from the player, at the last count
	};
	struct FLooks
	{
		const FEarthRig* Rig = nullptr;
		int32 Coat = 0;
		double Size = 1.0;
	};
	struct FParked
	{
		uint32 Id = 0;
		double X = 0.0;
		double Z = 0.0;
		double Yaw = 0.0; // compass degrees
		FLooks Looks;
		double D = 0.0;
	};
	struct FCar
	{
		EarthLife::FTrip Trip;
		FLooks Looks;
	};
	struct FTrain
	{
		EarthLife::FTrip Trip;
		const FEarthRig* Rig = nullptr;
		int32 Coat = 0;
	};
	/** A tree or a house: it stands still, and can be talked to. */
	struct FFixed
	{
		bool bHouse = false;
		double X = 0.0;
		double Z = 0.0;
		uint32 Thing = 0;
	};
	struct FChunk
	{
		TArray<FFixed> Fixed;
		TArray<FHerd> Herds;
		TArray<FParked> Parked;
		TArray<FCar> Trips;
		TArray<FTrain> Trains;
	};
	/** How an animal (or a tractor) is reacting to players: a short offset from where the clock puts it. */
	struct FState
	{
		double Lag = 0.0;
		double TootAt = 0.0;
		double Ox = 0.0;
		double Oz = 0.0;
		double Up = 0.0;
		double Yaw = 0.0; // radians, anticlockwise from north seen from above, as the browser keeps it
		double Walk = 0.0;
		double Head = 0.0;
		double Look = 0.0;
		double Gait = 0.0;
		bool bStartled = false;
		bool bGreeted = false;
		double QuietUntil = 0.0;
	};
	struct FCarState
	{
		double Lag = 0.0;
		double Yaw = 0.0;
		bool bYawSet = false;
		double TootAt = 0.0;
	};
	struct FTrainState
	{
		bool bWasMoving = false;
		bool bSeen = false;
		double WhistleAt = 0.0;
	};
	/** Where a figure stands: metres (x east, y up, z south), its turn and its size. */
	struct FBase
	{
		FVector Position = FVector::ZeroVector; // engine units
		FQuat Rotation = FQuat::Identity;
		double Size = 1.0;
	};
	struct FPose
	{
		const FState* State = nullptr; // null: at rest
		double Flap = 0.0;
		double Swing = 0.0;
		double Beat = 0.0;
		double Wag = 1.0;
		bool bTogether = false;
		bool bStandIn = false; // far off: the big shapes only
	};

	static FLooks LooksOf(uint32 Id);
	/** Every train this game has, one of each, whichever chunk it came with. */
	void EachTrain(TFunctionRef<void(const EarthLife::FTrip&)> Do) const;
	void Sync(const FVector2D& Me);
	/** Draws one animal. Returns how: Whole (alive to who is about), Simple (a far-off stand-in), Flying, or Unseen. */
	enum class EDrawn : uint8 { Unseen, Whole, Simple, Flying };
	EDrawn DrawAnimal(const AEarthWorld* World, const FHerd& Herd, int32 K, double Dt, double T, int64 Slot, const TArray<FVector2D>& Players, bool bMayBeWhole, bool bMayBeSimple);
	void DrawTraffic(const AEarthWorld* World, double Dt, double T, const TArray<FVector2D>& Players, double MyHeight);
	/** Draws an animal, a tractor, a boat or a car that somebody is riding, has left standing or has told what to do, where they took it. */
	void PutMount(const FEarthThing& Mount, double T);
	void Put(const FEarthRig& Rig, const FLinearColor& CoatA, const FLinearColor& CoatB, const FBase& Base, const FPose& Pose, double T);
	void MakeModels();
	void FlushOne(UInstancedStaticMeshComponent* Shape, TArray<FTransform>& Wanted, TArray<float>& Paint);
	void Call(const TCHAR* Kind, uint32 Id, double X, double Y, double Z);
	/** -EWLifeWhere=<shared time>: logs where every animal, car and train near the player is at that moment, by latitude and longitude. */
	void LogWhere(const AEarthWorld* World, double T) const;
	void Flush();

	UPROPERTY()
	TObjectPtr<UStaticMesh> ShapeMeshes[4];

	UPROPERTY()
	TObjectPtr<UInstancedStaticMeshComponent> Shapes[4];

	UPROPERTY()
	TObjectPtr<UMaterialInterface> FigureMaterial;

	/** Ready-made models standing in for some vehicles (EarthModels.h); none with -EWModels=ours. */
	UPROPERTY()
	TArray<TObjectPtr<UStaticMesh>> ModelMeshes;

	UPROPERTY()
	TArray<TObjectPtr<UInstancedStaticMeshComponent>> ModelShapes;

	UPROPERTY()
	TObjectPtr<UEarthSounds> Sounds;

	TMap<FIntPoint, FChunk> Chunks;
	/** Near the player, nearest first; rebuilt a couple of times a second and whenever a chunk comes or goes. */
	TArray<const FHerd*> Herds;
	TArray<const FParked*> Parked;
	TArray<const FCar*> Trips;
	TArray<const FTrain*> Trains;
	TMap<uint32, FState> States;
	TMap<uint32, FCarState> CarStates;
	TMap<uint32, FTrainState> TrainStates;

	TArray<FEarthThing> Nearby;
	TArray<FEarthThing> Rideable;
	TSet<uint32> Taken;
	TArray<FEarthThing> Mounts;

	/** This frame's shapes, per kind of shape: where each goes, and its colour (three numbers each). */
	TArray<FTransform> Transforms[4];
	TArray<float> Colours[4];

	/** The same for the ready-made models: which one stands in for which vehicle, and this frame's. */
	TMap<const FEarthRig*, int32> ModelOf;
	TArray<TArray<FTransform>> ModelTransforms;
	TArray<TArray<float>> ModelColours;
	bool bModelsMade = false;

	FVector EarsNow = FVector::ZeroVector;
	bool bDirty = true;
	float SyncTimer = 0.f;
	double LastTime = 0.0;
	int32 Shown = 0;
	double LogAt = 0.0;
	double WorkSeconds = 0.0; // time spent in Update since the last log line, and over how many frames
	int32 WorkFrames = 0;
	double WhereAt = 0.0; // when to write the -EWLifeWhere lines; 0 before anything is near, -1 once written
};
