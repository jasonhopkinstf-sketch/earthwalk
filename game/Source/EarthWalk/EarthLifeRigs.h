#pragma once

#include "CoreMinimal.h"

/**
 * What each animal and vehicle looks like and how it behaves near people: the tables of
 * server/public/js/liferigs.js, turned into C++ by game/Tools/gen-life-rigs.mjs so the two games
 * cannot drift apart. A figure stands with its feet at the origin facing north, and is built from
 * the engine's basic shapes. The comments in liferigs.js say what every number means.
 */
enum class EEarthShape : uint8 { Sphere, Cyl, Cone, Box, Count };
enum class EEarthRole : uint8 { None, Head, Leg0, Leg1, Leg2, Leg3, Tail, TailUp, Wing0, Wing1 };

struct FEarthRigPart
{
	static constexpr uint32 CoatA = 0xff000001; // the animal's coat
	static constexpr uint32 CoatB = 0xff000002; // its second colour

	// As written in liferigs.js: metres, x east, y up, z south.
	EEarthShape Shape;
	uint32 Colour; // 0xRRGGBB, or CoatA / CoatB
	double At[3];
	double Size[3];
	EEarthRole Role;
	double Tilt;

	// Worked out once, in engine terms: centimetres, X forward, Y right, Z up.
	FVector AtCm = FVector::ZeroVector;
	FQuat TiltQuat = FQuat::Identity;
	FVector Scale = FVector::OneVector; // of the engine's 100 cm shape, for a figure of size 1
	FVector PivotCm = FVector::ZeroVector; // what a moving part turns about
	FLinearColor Paint = FLinearColor::White; // for parts that are not coat-coloured
	bool bSmall = false; // eyes, ears and the like: left off the far-away stand-ins
};

struct FEarthRigCoat
{
	uint32 A;
	uint32 B;
};

struct FEarthRig
{
	FString Name;
	bool bVehicle = false;
	const TCHAR* Voice = nullptr;
	const TCHAR* Alarm = nullptr;
	double Alert = 0.0;
	double Flee = 0.0;
	double Stride = 1.0;
	double Graze = 0.0;
	double Drop = 0.0;
	FVector Neck = FVector::ZeroVector;
	bool bPeck = false;
	double Hop = 0.0;
	bool bSwim = false;
	double Swim = 0.0;
	double Waddle = 0.0;
	double TakesOff = 0.0;
	double Curious = 0.0;
	bool bFly = false;
	bool bFlock = false;
	double Yields = 0.0;
	double Heel = 0.0;
	bool bWing = false;
	FVector2D WingAir = FVector2D::ZeroVector; // middle and swing of the flap, in radians
	FVector2D WingWalk = FVector2D::ZeroVector;
	bool bWingStartled = false;
	FVector2D WingStartled = FVector2D::ZeroVector;
	double WingRate = 0.0;
	TArray<FEarthRigCoat> Coats;
	TArray<FEarthRigPart> Parts;

	TArray<FLinearColor> PaletteA;
	TArray<FLinearColor> PaletteB;
	double HeightM = 1.0;
};

namespace EarthRigs
{
	/** The figure of an animal, a tractor or a boat (the names of lifemotion.js), a "car", a "van" or a "railcar". Null when unknown. */
	const FEarthRig* Find(const FString& Name);

	/**
	 * Rotations as liferigs.js and life.js write them (radians about the browser's x east, y up and
	 * z south, applied z first, then x, then y), as an engine rotation.
	 */
	FQuat Turned(double AboutX, double AboutY, double AboutZ);

	/** A browser position (metres: x east, y up, z south) in the engine's figure space (cm: X forward, Y right, Z up). */
	inline FVector ToCm(double X, double Y, double Z) { return FVector(-Z * 100.0, X * 100.0, Y * 100.0); }
}
