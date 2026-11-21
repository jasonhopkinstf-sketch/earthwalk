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
};

namespace EarthMounts
{
	/** Null for a thing that cannot be ridden. */
	const FEarthMount* Find(const FString& Sp);

	/** What each kind of thing is called ("hen" for a chicken); null for a kind nobody can talk to. */
	const TCHAR* Called(const FString& Sp);

	/** The identity of a tree or a house, from where it stands in tile coordinates, so everyone gets the same one. */
	uint32 FixedThing(bool bHouse, double TileX, double TileY);
}
