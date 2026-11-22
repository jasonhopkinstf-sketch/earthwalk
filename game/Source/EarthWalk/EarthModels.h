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

	/** Builds model Index as a mesh that belongs to Outer. */
	UStaticMesh* Build(UObject* Outer, int32 Index);
}
