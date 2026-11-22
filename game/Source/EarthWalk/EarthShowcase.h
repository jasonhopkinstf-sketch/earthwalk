#pragma once

#include "CoreMinimal.h"
#include "Templates/Function.h"
#include "UObject/Object.h"
#include "EarthShowcase.generated.h"

class AEarthWalkCharacter;
class AEarthWorld;
struct FEarthSpot;

/** One thing to show somebody (docs/PROTOCOL.md, "Things to show"). */
struct FEarthShow
{
	FString Id;
	FString Title;
	FString Text; // what will be seen
	FString How;  // what to press on arriving
	FString Find; // train, home, car, door or air
	TArray<FString> Sp;
	bool bRide = false;
	FString Place;
	double Lat = 0.0;
	double Lon = 0.0;
};

DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthShowLine, const FString& /*Text*/, bool /*bProblem*/);

/**
 * "Show me...": a list of things the world can do, for showing it to somebody. Choosing one puts the
 * player right beside the thing itself: where the train is about to stop, next to a horse, at a
 * parked car, in front of a door that opens. The Windows counterpart of server/public/js/showcase.js,
 * which it follows line for line.
 *
 * The list comes from the server (GET /v1/showcase), each entry with a real place where the thing is
 * to be found. If one is already near the player it is used; otherwise the player travels to the
 * place, and is stood beside the thing once the world there has arrived.
 */
UCLASS()
class UEarthShowcase : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWorld* InWorld);

	/** Asks the server for the list, once; Done hears whether there is one. */
	void Load(TFunction<void(bool bOk)> Done);
	const TArray<FEarthShow>& GetShows() const { return Shows; }

	/** Takes the player to a show: by its id, or by words out of its title ("/show train"). */
	void Go(const FString& What);

	/** Every frame. T is the shared clock in seconds. */
	void Frame(AEarthWalkCharacter* InPlayer, double T);

	/** What to tell the player: where they are being taken, what to press there, or why not. */
	FOnEarthShowLine OnLine;

private:
	void Start(const FString& What);
	/** The nearest thing of the show's kind to a spot, within so many metres, in what this game has loaded. Trains are chosen by how soon one will be standing still. */
	bool Look(const FEarthShow& Show, double FromX, double FromZ, double Within, FEarthSpot& Out) const;
	void Stand(const FEarthShow& Show, const FEarthSpot& Spot);
	/** Puts the player on the ground at a spot, looking at something. False where the ground is not there yet. */
	bool Put(double X, double Z, double LookX, double LookZ);
	void Say(const FString& Text) const { OnLine.Broadcast(Text, false); }
	void Problem(const FString& Text) const { OnLine.Broadcast(Text, true); }

	TWeakObjectPtr<AEarthWorld> World;
	TWeakObjectPtr<AEarthWalkCharacter> Player;
	double Now = 0.0; // the shared clock, as of the last frame

	TArray<FEarthShow> Shows;
	bool bLoaded = false;
	bool bLoading = false;
	TArray<TFunction<void(bool)>> Waiting;

	// A show travelled to, waiting for the world there.
	bool bPending = false;
	FEarthShow Pending;
	double PendingSince = 0.0; // when the player landed; 0 until then
	bool bHopped = false;      // gone along the line once already, to where a train is

	// An animal to be put within reach of, once it is drawn.
	bool bSnap = false;
	TArray<FString> SnapSp;
	double SnapAt = 0.0;
	double SnapUntil = 0.0;
};
