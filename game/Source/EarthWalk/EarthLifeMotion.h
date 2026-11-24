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
	};
	FTripPose TripPose(const FTrip& Trip, double T);

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
