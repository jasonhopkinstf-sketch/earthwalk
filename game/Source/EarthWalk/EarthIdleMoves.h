#pragma once

#include "CoreMinimal.h"

/**
 * What a fidget adds to a figure's own standing about, in the terms of UEarthAnimalFigure::Animate (and of
 * figuremotion.js): angles in radians, lengths in metres, index 0 of a pair the left side and 1 the right.
 * Spin turns the whole figure about its feet, to its right.
 */
struct FEarthFidget
{
	float Lift = 0.f, Squash = 0.f, Spin = 0.f, Pitch = 0.f, Roll = 0.f, Twist = 0.f;
	float HeadPitch = 0.f, HeadYaw = 0.f, HeadRoll = 0.f;
	float ArmSwing[2] = { 0.f, 0.f }, ArmOut[2] = { 0.f, 0.f }, FootSwing[2] = { 0.f, 0.f }, FootLift[2] = { 0.f, 0.f };
	float TailYaw = 0.f, TailUp = 0.f;
};

/**
 * What a player's animal gets up to when it has been left standing for half a minute: it fidgets (a wave, a
 * little dance, a spin, a stretch, a few hops, a look at its own foot, nodding off, chasing its tail) and now
 * and then says something to itself. The same sums as server/public/js/idlemoves.js: keep the two in step.
 * Nothing about it is sent: everything follows from how long the figure has stood still and a number of its
 * own, so every game that watches the same player stand about sees much the same thing.
 */
namespace EarthIdle
{
	/** What a figure that has stood still a while is doing: cycle N of nine seconds each, the fidget and how far through it is (U below 0 in the rest after it), and what it says (below 0: nothing). */
	struct FNow
	{
		int32 N = 0;
		int32 Fidget = 0;
		float U = -1.f;
		int32 Say = -1;
	};
	/** False before half a minute is up (-EWIdleAfter=<seconds> makes it sooner, for tests). */
	bool At(double Still, uint32 Seed, FNow& Out);
	/** The pose a fidget adds, a fraction U of the way through it; nothing when U is below 0. */
	void Pose(int32 Fidget, float U, FEarthFidget& Out);
	/** What a figure says to itself. */
	const TCHAR* Mutter(int32 Index);
	/** A number of a figure's own, from its id. */
	uint32 SeedOf(const FString& Text);
	/** A race or a game is on, or a lesson: nobody fidgets, so that a hider can keep still. Set by the screen every frame. */
	extern bool bQuiet;
}
