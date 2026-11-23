#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "EarthFlight.generated.h"

class AEarthWalkCharacter;
class AEarthWalkHUD;
class AEarthWorld;

/**
 * The flight from one place to another: planFlight of server/public/js/flightplan.js, whose words on
 * why there are two kinds are not repeated here. In chunks (x east, y south) where it says so.
 */
struct FEarthFlightPlan
{
	bool bLow = true;     // over the rooftops; else up into the haze, across, and down
	double Metres = 0.0;  // as the crow flies
	double Seconds = 0.0; // when the world at the far end is there in time
	double Up = 0.0;      // a high flight's three parts, in seconds
	double Over = 0.0;
	double Down = 0.0;
	double Height = 0.0;  // above the ground
	double Ends = 0.0;    // metres along the ground a high flight covers climbing out, and again coming down
	int32 Steps = 0;      // chunk edges crossed
	int32 Chunks = 0;     // the most new chunks asked for
	double Fx = 0.0;
	double Fy = 0.0;
	double Dx = 0.0;
	double Dy = 0.0;
	double ToLat = 0.0;
	double ToLon = 0.0;
};

namespace EarthFlightSums
{
	/** False when the two places are too near to fly between. */
	bool Plan(double FromLat, double FromLon, double ToLat, double ToLon, FEarthFlightPlan& Out);
	double MetresBetween(double ALat, double ALon, double BLat, double BLon);
	/** "350 m", "2.4 km", "1,240 km". */
	FString FarWords(double Metres);
	/** "about 20 seconds", "about half a minute", "about a minute". */
	FString TimeWords(double Seconds);
	/** "Tour Eiffel, France" from the whole address. */
	FString ShortName(const FString& Name);
	/** Writes the plans of four known flights to the log, to hold against the browser's (-EWFlightCheck). */
	void Check();
}

/**
 * "Fly me there": the player is carried through the air to a place they chose, and watches
 * (server/public/js/flight.js is the browser's). A low flight goes up from where the player stands, over
 * the rooftops along a straight line and down beside the place, the world loading under it. A high one
 * climbs out until the ground is lost in the haze, moves the world's origin to the place, crosses in the
 * haze, and comes down as the ground there appears: our own world at both ends, and nothing pretended
 * in between (Jason's choice, 2026-11-23, over the photographic world from the air).
 *
 * The mouse looks round and V is the view from above, as on any ride; W, A, S, D, Space, C, F or Esc
 * takes over and leaves the player flying where they are.
 */
UCLASS()
class UEarthFlight : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	/** The flight from where the player is to a place; false when there is none to make (too near, or nowhere to take off from yet). */
	bool Plan(double Lat, double Lon, FEarthFlightPlan& Out) const;
	/** Sets off. False when there is no flight to make. */
	bool Start(const FString& Name, double Lat, double Lon);
	/** Every frame. bKeysFree: nothing is being typed, so the keys that take over count. Returns true when it used the Esc key. */
	bool Frame(float DeltaSeconds, bool bKeysFree);
	bool IsOn() const { return bOn; }
	void TakeOver(bool bQuiet = false);

	// What is said while flying: at the top of the screen, where the place is otherwise named, and along the foot of it.
	const FString& GetHead() const { return Head; }
	const FString& GetSub() const { return Sub; }
	FString GetHint() const { return bOn ? FString(TEXT("Esc takes over   ·   V looks from above")) : FString(); }
	/**
	 * For the little map: where the flight ends, in the scene (metres east and south of the world's origin), the
	 * place's name and how far there is still to go. While a high flight climbs out the place is far off the map,
	 * and is pointed to from its edge. False when nobody is being flown.
	 */
	bool MapGoal(double& X, double& Z, FString& OutName, double& OutLeft) const;

private:
	enum class EPart : uint8 { Low, Up, Over, Wait, Down, Settle };
	struct FSpot { double X = 0.0; double Z = 0.0; double Y = 0.0; bool bWet = false; };

	AEarthWalkCharacter* Flyer() const;
	bool RoofAt(double X, double Z, double& Out) const;
	bool Top(double X, double Z, double& Out) const;
	void Note(double Along, double Length);
	bool Landing(double X, double Z, FSpot& Out) const;
	void Put(double X, double Y, double Z);
	void Next(EPart To) { Part = To; T = 0.0; }
	void LowPart(double Dt);
	void UpPart();
	void OverPart(double Dt);
	void DownPart();
	void SettlePart(double Dt);
	void Landed();
	void Finish();
	void Words();

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TWeakObjectPtr<AEarthWorld> Earth;
	bool bOn = false;
	FEarthFlightPlan Going;
	FString Name;
	EPart Part = EPart::Low;
	double T = 0.0;
	int32 Generation = 0;
	// In the scene: metres east (X) and south (Z) of the world's origin, and up (Y).
	FSpot From;      // where it set off
	double DirX = 0.0; // the way it goes: one metre of it, east and south
	double DirZ = 0.0;
	double YawDeg = 0.0;
	double EndX = 0.0, EndZ = 0.0; // a low flight ends at the place, until clear ground beside it has been found
	double AimX = 0.0, AimZ = 0.0;
	bool bLand = false;
	FSpot Land;
	TMap<int32, double> Notes; // what must be cleared along a low flight's way, every eight metres
	double Base = 0.0;
	double Offset = 0.0;
	double Alt = 0.0;
	FSpot Came; // where the crossing ended and the coming down began
	bool bGeo = false; // crossing in the haze: where the flyer really is on Earth, which the scene cannot say
	double GeoLat = 0.0, GeoLon = 0.0, GeoW = 0.0;
	double TileM0 = 1.0, TileM1 = 1.0;
	double Left = 0.0;
	double NowX = 0.0, NowY = 0.0, NowZ = 0.0;
	bool bLooked = false; // the player has looked round for themselves: the view is theirs
	FRotator LookSet = FRotator::ZeroRotator;
	bool bLookSet = false;
	FString Head;
	FString Sub;
};
