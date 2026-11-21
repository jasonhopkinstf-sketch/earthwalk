#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;

/**
 * The photographic world: Google Photorealistic 3D Tiles streamed by the Cesium for Unreal plugin.
 * AEarthWorld uses it two ways (EEarthWorldKind): as the whole world, walked on (/world photo), or
 * as the view from the air over our own generated world (/world auto).
 *
 * The plugin is optional. EarthWalk.Build.cs sets EARTHWALK_CESIUM when it is installed; without it
 * these functions do nothing and the game stays on the generated world.
 *
 * The tiles use Cesium's own frame (+X east, +Y south), so the tileset actor is turned a quarter
 * turn to match ours (+X north, +Y east), and the Cesium georeference origin follows
 * AEarthWorld::SetOrigin. Heights differ: the tiles are measured from the WGS84 ellipsoid, our
 * world from sea level, which is some tens of metres apart depending on where you are. Walked on,
 * the player is put on the ground the tiles report (SampleGround) and only the reported altitude
 * shows it. Over the generated world the two have to agree, so the georeference is raised by the
 * difference measured on the spot (SetOrigin's height).
 *
 * The tiles are aerial photogrammetry: convincing from the air, rough from head height, where trees
 * and houses turn into large blurred slabs. That is the data, not a loading fault; a finer screen-space
 * error setting gives the same picture.
 */
namespace EarthPhoto
{
	/** True when the game was built with the Cesium plugin. */
	bool IsBuiltIn();

	/**
	 * Moves the Cesium georeference so engine (0, 0, 0) is this place, HeightMeters above the ellipsoid.
	 * With the height that separates sea level from the ellipsoid there, the tiles sit at our heights.
	 */
	void SetOrigin(UWorld* World, double Lat, double Lon, double HeightMeters = 0.0);

	/**
	 * Creates the tileset actor; Google's attribution is drawn on screen by the plugin. Null if the
	 * plugin is missing. Walkable tiles get collision, which costs loading time and is only wanted
	 * when the player stands on them.
	 */
	AActor* SpawnTileset(UWorld* World, const FString& GoogleMapTilesKey, bool bWalkable);

	/** Stops (or resumes) the tileset asking Google for tiles as the camera moves. What is loaded stays. */
	void SetSuspended(AActor* Tileset, bool bSuspended);

	/** How much of what the camera needs has loaded, 0 to 100. */
	float LoadProgress(const AActor* Tileset);

	/**
	 * Asks the tiles for the height of their top surface at some places (X latitude, Y longitude), at
	 * full detail and whatever the camera is looking at. Done is called later on the game thread with
	 * metres above the ellipsoid for each place, in order, and whether there was an answer for it
	 * (none without the plugin). A suspended tileset answers once it is resumed.
	 */
	void SampleHeights(AActor* Tileset, const TArray<FVector2D>& LatLon, TFunction<void(const TArray<double>& Heights, const TArray<bool>& Found)> Done);

	/**
	 * The same for one place, as the engine Z in cm. The answer is for the origin that is set when it
	 * arrives, so callers drop it if the origin has moved since they asked.
	 */
	void SampleGround(UWorld* World, AActor* Tileset, double Lat, double Lon, TFunction<void(bool bFound, double Z)> Done);
}
