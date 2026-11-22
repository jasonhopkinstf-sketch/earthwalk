#pragma once

#include "CoreMinimal.h"

class UStaticMesh;

/**
 * Ready-made models that can stand in for the game's own vehicles: a trial (2026-11) of whether bought
 * or free models look better than the shapes the game builds itself. Only when the game is started
 * with -EWModels=free; without it nothing here is used.
 *
 * The models are three cars from Kenney's Car Kit (www.kenney.nl, public domain), turned into the table
 * EarthModels.gen.inl by game/Tools/gen-models.mjs. Each becomes one mesh, already the right way round
 * and the right size for a figure of size 1, with its colours on its corners; the corners that carry
 * the car's main paint have alpha 1, and M_EarthModel paints those in the colour each car carries.
 */
namespace EarthModels
{
	/** True when this run was started with -EWModels=free. */
	bool On();

	int32 Num();

	/** The vehicle (its name in liferigs.js) that model Index stands in for. */
	const TCHAR* RigOf(int32 Index);

	/** Builds model Index as a mesh that belongs to Outer. */
	UStaticMesh* Build(UObject* Outer, int32 Index);
}
