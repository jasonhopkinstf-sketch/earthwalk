#pragma once

#include "CoreMinimal.h"

class UStaticMesh;

/**
 * Ready-made models that stand in for some of the game's own vehicles: cars, vans and taxis look far
 * more like themselves than the boxes the game builds from its four basic shapes. Started with
 * -EWModels=ours, the game draws its own shapes as before. The browser game has the same models
 * (server/public/js/models.gen.js, drawn by life.js).
 *
 * The models are three cars from Kenney's Car Kit (www.kenney.nl, public domain), turned into the table
 * EarthModels.gen.inl by game/Tools/gen-models.mjs. Each becomes one mesh, already the right way round
 * and the right size for a figure of size 1, with its colours on its corners; the corners that carry
 * the car's main paint have alpha 1, and M_EarthModel paints those in the colour each car carries.
 */
namespace EarthModels
{
	/** True unless this run was started with -EWModels=ours. */
	bool On();

	int32 Num();

	/** The vehicle (its name in liferigs.js) that model Index stands in for. */
	const TCHAR* RigOf(int32 Index);

	/** Builds model Index as a mesh that belongs to Outer: its body, without its wheels. */
	UStaticMesh* Build(UObject* Outer, int32 Index);

	/** How high a rider on the roof of a vehicle sits, metres above the ground it stands on; 0 for one with no model (or with -EWModels=ours). */
	double SeatOf(const FString& Rig);

	/** The wheels are meshes of their own, each kind once (most cars share one), about their own middle, so that they can roll. */
	int32 NumWheelKinds();
	UStaticMesh* BuildWheel(UObject* Outer, int32 Kind);
	struct FWheelAt
	{
		int32 Kind = 0;
		FVector At = FVector::ZeroVector; // its middle, in the model's own space: cm, X forward, Y right, Z up
		bool bFlip = false;               // turned half round: a wheel of the right-hand side
		double Radius = 0.4;              // metres
	};
	/** Where model Index's wheels stand. */
	void WheelsOf(int32 Index, TArray<FWheelAt>& Out);
}
