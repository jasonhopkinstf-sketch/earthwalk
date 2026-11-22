#pragma once

#include "CoreMinimal.h"

class UMaterialInstanceDynamic;
class UWorld;

/**
 * The game has two looks, drawn from the same world with the same materials:
 *
 *   barnyard  the painted picture-book look: brushed colour, drawn tiles and bricks, light in three
 *             levels, a soft dark line round things.
 *   flat      like a television cartoon: one bright even colour to a surface, almost no shading, a bold
 *             black line round everything, a plain blue sky with white clouds.
 *
 * A look is nothing but numbers: the dials of the materials built by EarthWalkAssetsCommandlet.cpp
 * (Flat, Vivid and Marks on the painted surfaces, the settings of M_EarthInk and M_EarthSky) and a
 * second palette for the ground (StyleFor in EarthWorld.cpp). So changing look needs no loading, and
 * /look changes it while you watch.
 */
enum class EEarthLook : uint8
{
	Barnyard,
	Flat,
};

namespace EarthLook
{
	/** The look in use: what /look last chose in this run, else -EWLook= or the saved choice, else the project's (UEarthWalkSettings::Look). */
	EEarthLook Current();
	const TCHAR* Name(EEarthLook Look);
	/** "flat" or "barnyard", in any case; false for anything else. */
	bool Parse(const FString& Text, EEarthLook& Out);

	/** Chooses a look, remembers it for next time, and repaints everything already on screen. */
	void Choose(UWorld* World, EEarthLook Look);

	/**
	 * Sets a painted material's dials for the look in use (M_EarthTop, M_EarthWall, M_EarthWater,
	 * M_EarthFoliage). -EWPaint=Name:value,Name:value tries other values for one run.
	 */
	void PaintSurface(UMaterialInstanceDynamic* Material);
	/** M_EarthInk's settings for the look, then the InkTuning setting, then -EWInk=Name:value,... for one run. */
	void TuneInk(UMaterialInstanceDynamic* Ink);
	/** M_EarthSky's settings for the look, then -EWSky=Name:value,... for one run. */
	void TuneSky(UMaterialInstanceDynamic* Sky);
}
