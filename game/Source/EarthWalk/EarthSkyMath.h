#pragma once

#include "CoreMinimal.h"

/**
 * Where the sun and the moon really stand, the light the world is drawn in because of it, and what each
 * kind of weather does to the picture. The same sums and the same numbers as server/public/js/skymath.js
 * and weatherdata.js: keep them in step (server/test/sky.test.ts holds the browser's to known days, and
 * -EWSkyCheck writes this game's answers for the same days to the log).
 *
 * No service is asked for the sun and the moon: they follow from the place and the moment. Angles are
 * radians unless a name ends in Deg; a direction in the sky is Alt (above the horizon) and Az (round from
 * north through east). Colours are amounts of light, not screen colours.
 */
namespace EarthSkyMath
{
	struct FSun
	{
		double Alt = 0.0;
		double Az = 0.0;
	};
	struct FMoon
	{
		double Alt = 0.0;
		double Az = 0.0;
		double Lit = 0.0; // the part of its face in sunshine, 0 (new) to 1 (full)
		bool bWaxing = false;
		double Age = 0.0; // where it is in its month, 0 to 1 (0 new, 0.5 full)
	};
	/** The moment is milliseconds since 1970; the place degrees north and east. */
	FSun SunAt(double Ms, double LatDeg, double LonDeg);
	FMoon MoonAt(double Ms, double LatDeg, double LonDeg);
	/** "full moon", "waxing crescent"... */
	const TCHAR* MoonName(double Age);
	/** A direction in the sky as a step of one unit in the engine: X north, Y east, Z up. */
	FVector Direction(double Alt, double Az);
	/**
	 * A time of day to try out: the moment within the day round Ms when the sun over the place is highest
	 * ("noon"), lowest ("night"), or four degrees up on its way up ("morning") or down ("sunset").
	 */
	double MomentOf(const FString& When, double Ms, double LatDeg, double LonDeg);
	/** The fine day the game had before it knew the time: the sun high, where it always was. */
	FSun FineDay();

	/** The light the world is drawn in (skyLight in skymath.js). */
	struct FLight
	{
		double Day = 1.0, Dusk = 0.0, Night = 0.0;
		FLinearColor Zenith, Mid, Horizon, FlatSky, Glow, DuskGlow, SunDisc, Land, Haze, FogColour, Cloud, CloudShade, Hour;
		double SunShow = 1.0, Stars = 0.0, MoonShow = 0.0, MoonGlow = 0.0, Veil = 0.0, Mist = 0.0;
		// The one light that casts: the sun's, the moon's, or starlight's.
		int32 From = 0; // 0 sun, 1 moon, 2 stars
		double CastAlt = 0.0, CastAz = 0.0, CastStrength = 0.0;
		FLinearColor CastColour;
		// The light from all round.
		FLinearColor SkyColour, GroundColour;
		double SkyStrength = 0.0;
	};
	/** Moon null for none (the fine day). Veil and Mist are the weather's part, 0 to 1. */
	FLight Light(const FSun& Sun, const FMoon* Moon, double Veil, double Mist);
	/** How brightly a level patch of open ground is lit, against a fine noon's 1.6 or so (groundLevel in skymath.js). */
	double GroundLevel(const FLight& Light);

	/** A report of the weather, as GET /v1/weather sends it. */
	struct FWeather
	{
		FString Kind = TEXT("fine"); // fine, cloudy, fog, drizzle, rain, snow, storm
		double Cloud = 0.6, Rain = 0.0, Snow = 0.0, Wind = 2.4, Gust = 4.0, WindFrom = 270.0, Temp = 18.0;
		double Visibility = -1.0; // metres; below 0 for not said
	};
	/** What a report does to the picture and the sound (weatherLook in weatherdata.js). */
	struct FWeatherLook
	{
		double Clouds = 0.66, Veil = 0.0, Mist = 0.0, FogNear = 900.0, FogFar = 2600.0;
		int32 RainCount = 0;
		double RainSpeed = 11.0, RainLength = 0.55, RainWidth = 0.016;
		int32 SnowCount = 0;
		double SnowSpeed = 1.5, SnowSize = 0.055, SnowSway = 0.35;
		int32 Leaves = 0;
		double WindEast = 0.0, WindSouth = 0.0; // metres a second over the ground
		double Drift = 1.0, Sway = 0.08, RainSound = 0.0, WindSound = 0.0;
		bool bThunder = false;
	};
	FWeatherLook Look(const FWeather& Weather);
	/** The fine day's weather, and the ones to try out by name (cloudy, drizzle, rain, storm, snow, fog, windy); false for a name that is none of them. */
	FWeather Fine();
	bool Try(const FString& Name, FWeather& Out);
	/** "real", "fine" or one of the kinds to try, from what was typed; empty for anything else. */
	FString ParseWeather(const FString& Text);
	/** "real", "day", "morning", "noon", "sunset" or "night", from what was typed; empty for anything else. */
	FString ParseTime(const FString& Text);
	/** The weather in a few plain words: "rain, 12 degrees, a breeze from the south-west". */
	FString WeatherSaid(const FWeather& Weather);
	/** The sky in plain words: where the sun is, and the moon. */
	FString SkySaid(const FSun& Sun, const FMoon* Moon, const FString& Trying);

	/** -EWSkyCheck: the sun and moon on known days, written to the log to hold against server/test/sky.test.ts. */
	void Check();
}
