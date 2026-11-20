#pragma once

#include "CoreMinimal.h"

/**
 * Web Mercator tile maths, matching server/src/geo.ts.
 * "Tile coordinates" are fractional tile indices at ChunkZoom: X grows east, Y grows south.
 */
namespace EarthGeo
{
	constexpr int32 ChunkZoom = 16;
	constexpr double TilesAcross = 65536.0; // 2^ChunkZoom
	constexpr double EarthCircumference = 40075016.686;

	inline double LonToX(double Lon) { return (Lon + 180.0) / 360.0 * TilesAcross; }

	inline double LatToY(double Lat)
	{
		const double R = FMath::DegreesToRadians(Lat);
		return (1.0 - FMath::Loge(FMath::Tan(R) + 1.0 / FMath::Cos(R)) / UE_DOUBLE_PI) / 2.0 * TilesAcross;
	}

	inline double XToLon(double X) { return X / TilesAcross * 360.0 - 180.0; }

	inline double YToLat(double Y)
	{
		const double N = UE_DOUBLE_PI * (1.0 - 2.0 * Y / TilesAcross);
		return FMath::RadiansToDegrees(FMath::Atan((FMath::Exp(N) - FMath::Exp(-N)) * 0.5));
	}

	/** Ground size in metres of one chunk at the given latitude. */
	inline double MetersPerTile(double Lat)
	{
		return EarthCircumference * FMath::Cos(FMath::DegreesToRadians(Lat)) / TilesAcross;
	}
}
