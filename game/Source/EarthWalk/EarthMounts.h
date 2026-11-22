#pragma once

#include "CoreMinimal.h"

/**
 * What can be ridden (MOUNTS in server/public/js/riding.js): its pace in metres a second (hold Shift
 * for all of it), how high the rider sits, what to call it, and how near you must be to hop on.
 * A boat keeps to water; the rest keep off it. A train has no pace: it keeps to its timetable.
 */
struct FEarthMount
{
	const TCHAR* Sp;
	double Speed;
	double Seat;
	const TCHAR* Name;
	double Reach; // 0: the usual three metres
	bool bAfloat;
	// A car, a taxi or a tractor is driven, not ridden: its top and reverse speeds (metres a second), how
	// hard it pulls and brakes (metres a second, each second), the distance between its axles and its
	// grip (`drive` of MOUNTS in riding.js). All nought for everything else.
	double Top = 0.0;
	double Reverse = 0.0;
	double Pull = 0.0;
	double Brake = 0.0;
	double Base = 0.0;
	double Grip = 0.0;
};

/** A car on the move (newCar and stepCar in server/public/js/cardrive.js). */
struct FEarthCar
{
	double Heading = 0.0; // compass heading in radians: 0 north, clockwise
	double Vx = 0.0;      // metres a second east
	double Vz = 0.0;      // and south
	double Speed = 0.0;   // along its heading
	double Steer = 0.0;   // how far the wheels are turned
	double Turn = 0.0;    // radians a second
	double Look = 0.0;    // how far the mouse has swung the view round the car
	double Idle = 9.0;    // seconds since the mouse last did
	double View = 0.0;    // where the camera looks from, as a heading
};

/** Something a player can walk up to: an animal, a car, a carriage, a tree, a house, or a thing drawn where its rider has taken it. */
struct FEarthThing
{
	uint32 Thing = 0;
	FString Sp;
	double X = 0.0; // metres east of the world's origin
	double Z = 0.0; // metres south of it
	double Y = 0.0; // metres above sea level, for a thing drawn out of its place
	double Yaw = 0.0; // radians, anticlockwise from north seen from above, as the browser keeps it
	double Reach = 0.0; // how near to be to hop on; 0 for the usual
	int32 K = 0; // which carriage of a train
	double Gait = 0.0; // how far it has walked, for its legs
	bool bMoving = false;
	FString Key; // drawn out of its place: "me", its rider's id, or empty when it stands by itself
	bool bOutOfPlace = false; // true for everything in the list of things being ridden, left or told what to do
	double Pitch = 0.0; // a driven car sits to the slope under its wheels: nose up, radians
	double Roll = 0.0;  // and leans out of a bend
	bool bOwnLook = false; // somebody's own car: this body ("car" or "van") in this paint, whatever its identity would give it
	FString Body;
	uint32 Paint = 0;
};

namespace EarthMounts
{
	/** Null for a thing that cannot be ridden. */
	const FEarthMount* Find(const FString& Sp);

	/**
	 * Moves a car's speed and heading on by Dt seconds; where it goes is the caller's affair. Throttle
	 * and Steer are -1 to 1. The same sums as stepCar in server/public/js/cardrive.js.
	 */
	void StepCar(FEarthCar& Car, const FEarthMount& How, double Dt, double Throttle, double Steer, bool bHandbrake);

	/** What each kind of thing is called ("hen" for a chicken); null for a kind nobody can talk to. */
	const TCHAR* Called(const FString& Sp);

	/** The identity of a tree or a house, from where it stands in tile coordinates, so everyone gets the same one. */
	uint32 FixedThing(bool bHouse, double TileX, double TileY);
}
