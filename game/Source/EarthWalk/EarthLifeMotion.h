#pragma once

#include "CoreMinimal.h"

/**
 * How animals, cars and trains move: the one rule every client follows (docs/PROTOCOL.md, "Life",
 * "Traffic" and "Trains"). This is a port of server/public/js/lifemotion.js and trafficmotion.js and
 * must give the same answers, so a Windows player and a browser player see the same cow in the same
 * place. Where a thing is at a moment comes from its identity and the shared clock alone.
 *
 * To check the port: node game/Tools/life-vectors.mjs <file>, then run the game with -EWLifeTest=<file>.
 *
 * Everything here is in the browser's terms: metres, x east and y south, compass headings in degrees.
 */
namespace EarthLife
{
	/** The same hash as server/src/geo.ts. */
	uint32 Hash32(uint32 A, uint32 B = 0);
	inline double Unit(uint32 A, uint32 B) { return Hash32(A, B) / 4294967296.0; }

	/** Seconds per step, the share of a step spent walking, pace in m/s, and how often it calls (0: never). */
	struct FSpecies
	{
		const TCHAR* Name;
		double Step;
		double Walk;
		double Pace;
		int32 Call;
		bool bFly; // the flock that circles overhead
		bool bLap; // a tractor or a boat going round its home
	};
	/** Null for an animal this game does not know. */
	const FSpecies* FindSpecies(const FString& Name);

	constexpr double CallSlot = 3.0;

	struct FHome
	{
		uint32 Id = 0;
		const FSpecies* Species = nullptr;
		int32 N = 1;
		double R = 1.0;
	};

	struct FCreature
	{
		uint32 Id = 0;
		double X = 0.0; // metres east of the home's centre
		double Y = 0.0; // metres south of it
		double Alt = 0.0; // metres above the ground at the home's centre (flocks only)
		double Yaw = 0.0; // compass heading in degrees
		bool bMoving = false;
		double Gait = 0.0; // metres moved so far in this step
		double Pace = 0.0; // metres a second right now
		bool bGraze = false;
	};

	inline uint32 MemberId(uint32 HomeId, int32 K) { return Hash32(HomeId, static_cast<uint32>(K + 1)); }

	/** Where animal K of a home is at shared time T (seconds since 1970 on the server's clock). */
	FCreature CreatureAt(const FHome& Home, int32 K, double T);

	/** When animal Id calls during call slot Slot (= floor(T / CallSlot)); false when it stays quiet. */
	bool CallTime(uint32 Id, const FSpecies& Species, int64 Slot, double& OutTime);

	/** A car at rest beside a trip's road: how far along the path, and how far to the side (positive: to the right of the way out). */
	struct FKerbSpot
	{
		double Along = 0.0;
		double Aside = 0.0;
		uint64 Key = 0; // whose spot it is: ParkedKey or RestKey
	};
	inline uint64 ParkedKey(uint32 Id) { return (uint64(1) << 32) | Id; }
	/** Where a trip's own car waits: at the start of its trip, or (bFar) at the far end. */
	inline uint64 RestKey(uint32 TripId, bool bFar) { return (uint64(bFar ? 3 : 2) << 32) | TripId; }

	/** A car's trip or a train's run, ready to replay. Path is x, y, seconds, three numbers a point. */
	struct FTrip
	{
		uint32 Id = 0;
		double W = 0.0;
		bool bLeft = false;
		double Da = 1.0;
		double Db = 1.0;
		TArray<double> Path;
		/**
		 * Where the trip crosses a bridge or runs through a tunnel: for each point of the path, how far the
		 * road or the rails are above the terrain there (below, in a tunnel). Empty for a trip on the ground.
		 */
		TArray<double> Lift;

		int32 N = 0;
		TArray<double> Dist;
		double Time = 0.0;
		double Length = 0.0;
		double Period = 0.0;
		/**
		 * What stands at the kerbs of the trip's road, for the car to steer out round (SetSpots). Not part of the
		 * trip itself, and told to it again whenever the cars about change: so it may be set on a trip held const.
		 */
		mutable TArray<FKerbSpot> Spots;
	};
	void Prepare(FTrip& Trip);

	/** The point D metres along the middle of the road, or along the track. */
	FVector2D PointAt(const FTrip& Trip, double D);
	/** How far above the terrain (below, in a tunnel) a trip or a run is, D metres along it: liftAt of trafficmotion.js. 0 on the ground. */
	double LiftAt(const FTrip& Trip, double D);
	/** Compass heading of the path D metres along it, taken across Reach metres either side. */
	double HeadingAt(const FTrip& Trip, double D, double Reach = 3.0);

	struct FTripPose
	{
		double X = 0.0;
		double Y = 0.0;
		double Yaw = 0.0;
		bool bMoving = false;
		int32 Leg = 0; // 0 waiting at the start, 1 driving out, 2 waiting at the far end, 3 driving back
		double Pace = 0.0;
		bool bInLane = false;
		double Lift = 0.0; // metres above the terrain: on a bridge, or on the ramp up to one
		double Rolled = 0.0; // metres driven since it last set off: what its wheels have turned through
		bool bOut = false; // it has steered out of its lane round a car at the kerb
	};
	/** Where a car is at shared time T. Every car the trip knows of at its kerbs (SetSpots) counts as standing there. */
	FTripPose TripPose(const FTrip& Trip, double T);

	// ---- cars at the kerb, and giving way: trafficmotion.js over again, under the same names. Keep the two in step.
	/** A car, for keeping cars out of each other: how long and how wide, in metres. */
	constexpr double CarLong = 4.3;
	constexpr double CarWide = 1.85;
	/** The air a moving car leaves between itself and a car at the kerb. */
	constexpr double KerbGap = 0.4;
	/** Two cars whose middles are this near along the road are side by side; a car steers out round one over SwerveM more. */
	constexpr double AbeamM = CarLong + 0.2;
	constexpr double SwerveM = 10.0;
	/** How much of the turn its path makes a car's body shows as it steers over. */
	constexpr double SteerShown = 0.5;
	/** At an end of its trip a car is let in to the kerb, or out from it, over this many metres, whatever stands next door. */
	constexpr double EndFreeM = 4.6;

	struct FAlong
	{
		double Along = 0.0;
		double Aside = 0.0;
		double D = TNumericLimits<double>::Max();
	};
	/** Where a point is against a trip's path: how far along the middle of the road, how far to the side of it, and how far off. */
	FAlong AlongOf(const FTrip& Trip, double X, double Y);
	/** A car at rest, in the trip's own metres, and whose spot it is. */
	struct FSpotAt
	{
		double X = 0.0;
		double Y = 0.0;
		uint64 Key = 0;
	};
	/** Tells a trip what stands at the kerbs of its road (its own two resting places are left out). */
	void SetSpots(const FTrip& Trip, const TArray<FSpotAt>& Spots);
	/**
	 * Where a car is at shared time T, when what stands at each of its kerb spots is asked for: Hold says how
	 * much a spot counts just now (1 a car at rest there, 0 nothing). Tuck (0 to 1) draws the car in to its own
	 * kerb as far as there is room: a car standing to let another by.
	 */
	FTripPose TripPose(const FTrip& Trip, double T, TFunctionRef<double(uint64 Key)> Hold, double Tuck = 0.0);
	/** Where a trip's car stands while it waits: at the start of its trip, or (bFar) at the far end. */
	FTripPose RestPose(const FTrip& Trip, bool bFar);

	/** A car's box on the ground: its middle, and the way it faces (a unit; x east, y south). */
	struct FCarBox
	{
		double X = 0.0;
		double Y = 0.0;
		double Fx = 0.0;
		double Fy = -1.0;
	};
	/** Whether two cars' boxes are inside each other. For giving way a car counts as a little larger than it is. */
	bool BoxesMeet(const FCarBox& A, const FCarBox& B, double Long = CarLong + 0.5, double Wide = CarWide + 0.1);

	/** How far ahead a car looks, in seconds of its own timetable: seven near, then seven far (for a car coming the other way through a narrow stretch). */
	constexpr int32 NumNear = 7;
	constexpr int32 NumLooks = 14;
	/** Two cars that have waited for each other this long are let through each other, so nothing stands for ever. */
	constexpr double StuckS = 8.0;
	/** The longest a car falls behind its timetable before it stops waiting for anything. */
	constexpr double LagMostS = 90.0;
	/** What a car keeps from one moment to the next of giving way. */
	struct FGiveState
	{
		double Lag = 0.0;   // seconds behind its timetable
		double Rate = 0.0;  // how fast it is falling behind: 1 standing still
		double Tuck = 0.0;  // drawn in to its kerb, to let another by
		double Stuck = 0.0;
		double Ghost = 0.0; // until this time it waits for no car: the way out of a jam
		bool bBlocked = false;
		bool bByCar = false;
	};
	struct FGivingCar
	{
		const FTrip* Trip = nullptr;
		FGiveState* St = nullptr;
		FTripPose Pose;
		FCarBox Box;
		FCarBox Ahead[NumLooks];
		bool bAhead[NumLooks] = {};
		bool bGoing = false;
		int32 Rank = 0;
		int32 Waits = 0;
		bool bJam = false;
	};
	/**
	 * One moment of giving way, for the cars a game has (giveWay of trafficmotion.js). Afterwards each has its
	 * Pose: where it is now, lag and all. Gone: whether a parked car's spot is empty just now. Also: whether
	 * something else is in a car's way (a player), which holds it back the same.
	 */
	void GiveWay(TArray<FGivingCar>& Cars, double T, double Dt, TFunctionRef<bool(uint32 ParkedId)> Gone, TFunctionRef<bool(const FGivingCar& Car)> Also);

	struct FTrainPose
	{
		double Along = 0.0; // metres along the track
		bool bBack = false;
		bool bMoving = false;
		int32 Leg = 0;
		double Stood = 0.0; // how many seconds it has been standing at the end of its run it is at (legs 0 and 2), else 0
	};
	FTrainPose TrainPose(const FTrip& Train, double T);

	// A train that carries on (trafficmotion.js, under that heading): a train's own run ends where its square of the
	// map does, and somebody riding does not want to be taken back, so where the track goes on their train goes along it.
	/** How long a train stands at the end of its run before it carries on down the line with whoever is aboard. */
	constexpr double ThroughDwellS = 6.0;
	/** Two runs are the same track going on when an end of each is this near the other, and they point much the same way. */
	constexpr double JoinM = 12.0;
	/** A run gone along once, by a clock of its own: Since seconds after setting off from one end (the far end when bBack). */
	struct FRunPose
	{
		double Along = 0.0;
		bool bMoving = false;
		bool bDone = false; // it has reached the other end
	};
	FRunPose RunPose(const FTrip& Train, double Since, bool bBack);
	/**
	 * The run a train goes on along from one end of its own (bFar: its far end, else its start): of Others, the one with
	 * an end nearest that point, within JoinM, that leads on much the way the train was going. Null when there is none.
	 * bOutBack: it is entered at its far end, and so run backwards.
	 */
	const FTrip* JoinOf(const FTrip& Train, bool bFar, const TArray<const FTrip*>& Others, bool& bOutBack);

	/**
	 * Runs the numbers of game/Tools/life-vectors.mjs through this port and logs the largest difference.
	 * Returns false when the file cannot be read or something is out by more than a hair.
	 */
	bool RunSelfTest(const FString& JsonFile);
}
