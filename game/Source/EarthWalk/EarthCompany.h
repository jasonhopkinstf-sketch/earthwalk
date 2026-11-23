#pragma once

#include "CoreMinimal.h"
#include "EarthMounts.h"
#include "EarthWalkNet.h"
#include "EarthWorld.h"
#include "UObject/Object.h"
#include "EarthCompany.generated.h"

class AEarthLife;
class AEarthRaceCourse;
class AEarthWalkCharacter;
class AEarthWorld;
struct FEarthMapMark;

DECLARE_MULTICAST_DELEGATE_ThreeParams(FOnEarthThingLine, const FString& /*Who*/, const FString& /*Text*/, bool /*bFromThing*/);

/**
 * The player's dealings with the living world: riding it (E), talking to it (T), and telling it what
 * to do. The Windows counterpart of riding.js, talk.js and orders.js in server/public/js, which it
 * follows closely; docs/PROTOCOL.md ("Riding", "Talking", "Doing as asked") is the agreement between
 * the two games and the server.
 *
 * - A ridden thing belongs to its rider: the rider's game moves it (it goes where they go) and
 *   everyone else draws it under them from the positions players already share. A train keeps to its
 *   timetable and carries its passengers.
 * - A thing that is talked to answers in a speech bubble above it, for everyone nearby.
 * - A thing told to follow, come or stay leaves its timetable and is drawn here, as a thing left
 *   standing by its rider is. "Take me to" is carried out by the rider's own game.
 */
UCLASS()
class UEarthCompany : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWorld* InWorld);

	/** Every frame, before the animals and cars are drawn. T is the shared clock in seconds. */
	void Frame(AEarthWalkCharacter* InPlayer, double Dt, double T);

	/** The E key: hop off, or hop on whatever is nearest; at a front door with nothing to ride, go in or out. */
	void KeyRide();
	/** Where the nearest house that can be gone into is, in words ("115 m to the north-east"); empty when none is loaded near here. */
	FString NearestHouse() const;
	/** The R key, or "/race" with a word: set a race up along the roads here, join one, start mine; "stop" leaves it. */
	void KeyRace(const FString& Word = FString());
	/** Who is in the race and how far along, a line each, for the corner of the screen; empty when there is no race. */
	const FString& GetRacePanel() const { return RacePanel; }
	/** The countdown to the start, large: "3", "2", "1", "GO!"; empty the rest of the time. */
	const FString& GetRaceCount() const { return RaceCount; }
	/** Brings the player's own car to stand beside them (/car), or sends it away. */
	void CallCar(bool bAway = false);
	/** Calls a taxi to take the player to a place (/taxi the beach). */
	void CallTaxi(const FString& Place, bool bAt = false, double Lat = 0.0, double Lon = 0.0);
	bool IsRiding() const { return Mine.bOn; }
	/** What kind of thing I am riding and steering myself ("car", "horse"); empty on foot, on a train, or behind a friend. */
	FString RidingKind() const { return Mine.bOn && Mine.Seat == 0 ? Mine.Sp : FString(); }
	/** Steps down from whatever is being ridden, if anything: before being taken somewhere else, or becoming another animal. */
	void HopOff() { Off(); }

	/** The T key: say hello to whatever is nearest. True if there was something to talk to. */
	bool KeyTalk();
	/** A round-up: whatever animal is beside me is told "follow me", with no conversation. False when nothing that can be led is near. */
	bool LeadNearest();
	/** Something typed while talking to a thing goes to it. */
	void Say(const FString& Text);
	void StopTalking();
	bool IsTalking() const { return bTalking; }
	/** "Daisy the cow", or "the cow" until she has introduced herself. */
	FString TalkingTo() const { return Title(To); }
	/** What kind of thing is being talked to ("cow", "car", "taxi", "tree"...), which thing it is, and whether I am riding it. */
	FString TalkingKind() const { return To.Sp; }
	uint32 TalkingThing() const { return To.Thing; }
	bool IsRidingIt() const { return bTalking && Mine.bOn && Mine.Thing == To.Thing; }
	/** Talking to somebody inside a shop or an office (EarthInside.h), who is asked about their work and not told to follow. */
	bool TalkingIndoors() const;
	/** The thing that spoke last, as OnLine is being told of it. */
	uint32 LastSpoke() const { return Spoke; }

	/**
	 * For the little map (EarthMiniMap.h): my own car and the taxi I called, wherever they stand; the
	 * gates of a race still to pass; and where I am being taken, with the road there from here and its name.
	 */
	void MapMarks(TArray<FEarthMapMark>& Out, TArray<FVector2D>& OutWay, FString& OutGoing) const;

	/** The house the player went into by its front door and has not come out of, wandered off from or been taken away from. */
	bool InHouse(FEarthDoor& Out) const
	{
		Out = HouseIn;
		return bInHouse;
	}

	/** What E and T would do just now, for the line at the foot of the screen; empty when nothing is near. */
	const FString& GetHint() const { return Hint; }

	/** What a thing said, where it is (engine units), and until when the bubble shows (FPlatformTime seconds). */
	struct FBubble
	{
		uint32 Thing = 0;
		FString Name;
		FString Text;
		FVector Where = FVector::ZeroVector;
		double Until = 0.0;
	};
	const TArray<FBubble>& GetBubbles() const { return Bubbles; }

	/** A line for the chat log: what somebody asked a thing, and what it answered. */
	FOnEarthThingLine OnLine;

private:
	uint32 Spoke = 0;

private:
	// ---- riding
	void OnRide(const FEarthRide& Ride);
	void OnRideFail();
	void Off();
	void Land();
	void RidingFrame(double Dt, double T);
	void Ridden(const FString& Key, uint32 Thing, const FString& Sp, double X, double Z, double Y, double Yaw, double Dt);

	// ---- talking
	void OnSay(const FEarthSay& Said);
	void Scan();
	void TalkFrame(double Dt);
	FString Title(const FEarthThing& Thing) const;

	// ---- doing as asked
	void OnOrder(const FEarthOrder& Order);
	void SetOff(const FEarthOrder& Order);
	void Steer(double Dt);
	void OrdersFrame(double Dt, double T);
	bool WhereIs(const FString& MemberId, double& OutX, double& OutZ) const;
	bool Find(uint32 Thing, const FString& Sp, FEarthThing& Out) const;
	void Stand(uint32 Thing, const FString& Sp, double X, double Z, double Yaw, double Gait, bool bMoving, double Lift, double Spin, double Tip = 0.0, double Lean = 0.0);
	/** Somebody's companion does a trick (tricks.js): drawn by PetFrame until it is done. */
	void OnTrick(const FString& MemberId, uint32 Thing, const FString& Sp, const FString& Trick);
	/** The young animals before the door of every house near here that has a garden (garden.js). */
	void GardenFrame(double T);

	// ---- taxis (taxi.js) and going into houses (houses.js)
	void OnTaxi(const FEarthTaxi& Taxi, bool bGone);
	void TaxiFrame(double T);
	void GarageFrame();
	void PetFrame(double Dt);
	void OnRace();

public:
	/** Has the companion of a member leap, as it comes to a jump on an agility course. */
	void Hop(const FString& MemberId);

private:
	struct FAct
	{
		FString Trick;
		double Start = 0.0;
	};
	TMap<uint32, FAct> Acts; // the trick each companion is in the middle of
	TMap<FString, int32> GatesSeen; // how many gates each runner had passed, to tell when one comes to a jump
	void RaceFrame(double T);
	void DoorFrame(double Dt);
	void UseDoor();

	/** A treasure found: the chest stands a few steps ahead of me, where I am looking. */
	void OnTreasure(double Lat, double Lon);

	// ---- shared
	void Notice(const FString& Text) const;
	bool PlayerAt(double& OutX, double& OutZ) const;
	void GeoToScene(double Lat, double Lon, double& OutX, double& OutZ) const;
	/** The ground a thing stands on, metres above sea level: the terrain, a little higher for a car (roads are laid on top of it). */
	/**
	 * The height something of this kind stands at. Near the player, or with FeetAt given (the height its
	 * rider is at), that is the floor there: a bridge's deck or a tunnel's floor where there is one, and
	 * the terrain everywhere else.
	 */
	/** How high the rider of this thing sits, metres: the usual for its kind, or the roof of the body this very car has. */
	double SeatFor(const FEarthMount& Mount, const FString& Sp, uint32 Thing) const;
	bool GroundFor(const FString& Sp, double X, double Z, double& OutY, double FeetAt = TNumericLimits<double>::Lowest(), const AActor* Ignore = nullptr) const;
	void TestAids(double Dt);

	TWeakObjectPtr<AEarthWorld> World;
	TWeakObjectPtr<AEarthWalkCharacter> Player;
	TWeakObjectPtr<UEarthWalkNet> Net;

	// What I am on, once the server has said so; what I have asked for; what E would hop on right now.
	FEarthRide Mine;
	const FEarthMount* MineMount = nullptr;
	int32 MineK = 0;
	double Lost = 0.0;
	bool bWanted = false;
	FEarthThing Wanted;
	double WantedAt = 0.0;
	bool bNear = false;
	FEarthThing Near;
	FString RideHint;

	// Identities drawn here instead of where their timetable has them, and where to draw each.
	TSet<uint32> Hidden;
	TArray<FEarthThing> Mounts;
	struct FGait
	{
		uint32 Thing = 0;
		double X = 0.0;
		double Z = 0.0;
		double D = 0.0;
	};
	TMap<FString, FGait> Gaits;

	// Who I am talking to, who T would talk to, and the names of those who have spoken.
	bool bTalking = false;
	FEarthThing To;
	bool bTalkNear = false;
	FEarthThing TalkNear;
	TMap<uint32, FString> Names;
	TArray<FBubble> Bubbles;
	double SinceScan = 0.0;
	FString TalkHint;
	FString Hint;

	// Where a thing under orders has got to, and tricks in mid-air.
	struct FOrderPose
	{
		double X = 0.0;
		double Z = 0.0;
		double Yaw = 0.0;
		double D = 0.0;
		double At = 0.0;
	};
	TMap<uint32, FOrderPose> Poses;
	struct FTrick
	{
		FString Sp;
		double Start = 0.0;
		double X = 0.0;
		double Z = 0.0;
		double Yaw = 0.0;
	};
	TMap<uint32, FTrick> Tricks;
	/** Where I am being taken. Path is in metres east and south of the world's origin as it was when the trip began. */
	struct FTrip
	{
		bool bOn = false;
		uint32 Thing = 0;
		FString Sp;
		FString Name;
		TArray<FVector2D> Path;
		int32 I = 0;
		double EndLat = 0.0;
		double EndLon = 0.0;
		bool bHasBest = false; // the nearest the end has been, to tell when the way is blocked
		double Best = 0.0;
		double Held = 0.0;
		int32 Hops = 0; // times it was lifted past something in the way
		double Age = 0.0; // seconds since it set off
		bool bMore = false; // a long drive: Path is one leg of it, and the server sends the next as its end comes near
	};
	FTrip Trip;
	bool bRemount = false;
	uint32 RemountThing = 0;
	FString RemountSp;

	// The race: its gates, which course they were stood up for, and what the screen says.
	TWeakObjectPtr<AEarthRaceCourse> Course;
	FString CourseKey;
	FString CourseShown;
	double CourseRetryAt = 0.0;
	FString RacePanel;
	FString RaceCount;

	// Where each companion has got to, by its identity.
	TMap<uint32, FOrderPose> PetPoses;
	// The ball a companion fetches and the hoop it leaps through (BALL and HOOP in pets.js): one of each,
	// shown where the trick being done wants it and put away when it is over.
	UPROPERTY()
	TObjectPtr<class AActor> TrickProps;
	UPROPERTY()
	TObjectPtr<class UStaticMeshComponent> TrickBall;
	UPROPERTY()
	TArray<TObjectPtr<class UStaticMeshComponent>> TrickHoop;
	bool bBallOut = false;
	bool bHoopUp = false;
	FVector BallWhere = FVector::ZeroVector;
	FVector HoopWhere = FVector::ZeroVector;
	double HoopYaw = 0.0;
	void ShowTrickProps();

	// Taxis somebody has boarded (riding draws those), and the ones whose arrival I have been told of.
	TSet<uint32> TaxisUsed;
	TSet<uint32> TaxisTold;

	// The door E would use, and which side of it I am on.
	bool bDoorNear = false;
	bool bInHouse = false;
	FEarthDoor HouseIn;
	/** How far above its real door the rooms I am in stand: nothing, but in a house built from its owner's plan. */
	double HouseLiftIn = 0.0;
	double LiftTriedAt = -100.0;
	double DoorTurnAfter = 0.0;
	double DoorWalkUntil = 0.0; // for a test: when the walk on from a spot in a house ends
	void StandInside(const FEarthDoor& Going, double Lift);
	void SetDown(const FEarthDoor& From);
	/** For a shop or an office: how far across its room is, in metres; I am "in" it while within that (and a bit) of the door I came in by. */
	double InsideSize = 50.0;
	bool bDoorInside = false;
	bool bDoorBusy = false;
	FEarthDoor Door;
	double SinceDoorScan = 0.0;
	FString DoorHint;
	int32 DoorTestStep = 0;
	bool bTaxiCalled = false;

	// -EWRide=<kind>, -EWTalk=<kind>, -EWSay=<words>: hop on, greet and speak to the nearest such thing unasked, for pictures and tests.
	double TestClock = 0.0;
	int32 TestStep = 0;
};
