#include "EarthSkyMath.h"

namespace
{
	constexpr double Rad = UE_DOUBLE_PI / 180.0;
	constexpr double Tau = UE_DOUBLE_TWO_PI;

	double TurnDeg(double Deg) { return FMath::Fmod(FMath::Fmod(Deg, 360.0) + 360.0, 360.0); }
	/** 0 below A, 1 above B, and a smooth slope between (B may be the lower of the two). */
	double Smooth(double A, double B, double V)
	{
		const double T = FMath::Clamp((V - A) / (B - A), 0.0, 1.0);
		return T * T * (3.0 - 2.0 * T);
	}
	double Mix(double A, double B, double T) { return A + (B - A) * T; }
	FLinearColor Mix3(const FLinearColor& A, const FLinearColor& B, double T)
	{
		const float F = static_cast<float>(T);
		return FLinearColor(A.R + (B.R - A.R) * F, A.G + (B.G - A.G) * F, A.B + (B.B - A.B) * F);
	}
	FLinearColor Times(const FLinearColor& C, double By)
	{
		const float F = static_cast<float>(By);
		return FLinearColor(C.R * F, C.G * F, C.B * F);
	}

	double DaysSince2000(double Ms) { return Ms / 86400000.0 - 10957.5; }
	double SiderealDeg(double N) { return TurnDeg(280.46061837 + 360.98564736629 * N); }

	/** From a place among the stars to a place in the sky over a spot on Earth. */
	void Overhead(double N, double Ra, double Dec, double LatDeg, double LonDeg, double& OutAlt, double& OutAz)
	{
		const double Hour = (SiderealDeg(N) + LonDeg) * Rad - Ra;
		const double Phi = LatDeg * Rad;
		OutAlt = FMath::Asin(FMath::Clamp(FMath::Sin(Phi) * FMath::Sin(Dec) + FMath::Cos(Phi) * FMath::Cos(Dec) * FMath::Cos(Hour), -1.0, 1.0));
		const double Az = FMath::Atan2(-FMath::Sin(Hour) * FMath::Cos(Dec), FMath::Sin(Dec) * FMath::Cos(Phi) - FMath::Cos(Dec) * FMath::Cos(Hour) * FMath::Sin(Phi));
		OutAz = FMath::Fmod(Az + Tau, Tau);
	}
	/** From the sun's road (longitude and latitude, degrees) to right ascension and declination. */
	void FromEcliptic(double N, double LambdaDeg, double BetaDeg, double& OutRa, double& OutDec)
	{
		const double Tilt = (23.439 - 0.0000004 * N) * Rad;
		const double L = LambdaDeg * Rad, B = BetaDeg * Rad;
		OutRa = FMath::Atan2(FMath::Sin(L) * FMath::Cos(Tilt) - FMath::Tan(B) * FMath::Sin(Tilt), FMath::Cos(L));
		OutDec = FMath::Asin(FMath::Clamp(FMath::Sin(B) * FMath::Cos(Tilt) + FMath::Cos(B) * FMath::Sin(Tilt) * FMath::Sin(L), -1.0, 1.0));
	}
	double SunLongitudeDeg(double N)
	{
		const double Mean = TurnDeg(280.460 + 0.9856474 * N);
		const double G = TurnDeg(357.528 + 0.9856003 * N) * Rad;
		return TurnDeg(Mean + 1.915 * FMath::Sin(G) + 0.020 * FMath::Sin(2.0 * G));
	}

	// The colours of the air and of the light, by day, at dusk and by night (AIR and LIGHT in skymath.js).
	struct FHour
	{
		FLinearColor Zenith, Mid, Horizon, Tint, Sun, Sky, Ground, Land, Cloud, CloudShade, Flat;
	};
	const FHour DayHour = {
		{ 0.025f, 0.15f, 0.70f }, { 0.10f, 0.36f, 0.86f }, { 0.42f, 0.70f, 0.95f },
		{ 1.f, 1.f, 1.f }, { 1.0f, 0.89f, 0.72f }, { 1.f, 1.f, 1.f }, { 0.102f, 0.144f, 0.091f }, { 1.f, 1.f, 1.f }, { 1.0f, 1.0f, 0.985f }, { 0.56f, 0.69f, 0.93f }, { 0.09f, 0.40f, 1.0f },
	};
	const FHour DuskHour = {
		{ 0.10f, 0.13f, 0.46f }, { 0.42f, 0.27f, 0.50f }, { 1.0f, 0.50f, 0.20f },
		{ 1.0f, 0.80f, 0.68f }, { 1.0f, 0.55f, 0.28f }, { 1.0f, 0.80f, 0.70f }, { 0.16f, 0.12f, 0.12f }, { 0.95f, 0.68f, 0.56f }, { 1.0f, 0.78f, 0.58f }, { 0.60f, 0.34f, 0.50f }, { 0.80f, 0.36f, 0.30f },
	};
	const FHour NightHour = {
		{ 0.016f, 0.03f, 0.15f }, { 0.03f, 0.065f, 0.25f }, { 0.07f, 0.14f, 0.36f },
		{ 0.36f, 0.44f, 0.78f }, { 0.62f, 0.74f, 1.0f }, { 0.55f, 0.68f, 1.0f }, { 0.12f, 0.16f, 0.30f }, { 0.20f, 0.29f, 0.52f }, { 0.30f, 0.37f, 0.60f }, { 0.13f, 0.17f, 0.34f }, { 0.03f, 0.07f, 0.34f },
	};
	// How strong the lights are, in the browser's own measure. The night's are high on purpose: never black.
	constexpr double StrengthSun = 2.1, StrengthSky = 1.15, StrengthMoon = 0.95, StrengthStars = 0.45, StrengthNightSky = 1.3;
	constexpr double HandoverDeg = -5.0;

	const TCHAR* const Points[] = { TEXT("north"), TEXT("north-east"), TEXT("east"), TEXT("south-east"), TEXT("south"), TEXT("south-west"), TEXT("west"), TEXT("north-west") };
}

EarthSkyMath::FSun EarthSkyMath::SunAt(double Ms, double LatDeg, double LonDeg)
{
	const double N = DaysSince2000(Ms);
	double Ra = 0.0, Dec = 0.0;
	FromEcliptic(N, SunLongitudeDeg(N), 0.0, Ra, Dec);
	FSun Sun;
	Overhead(N, Ra, Dec, LatDeg, LonDeg, Sun.Alt, Sun.Az);
	return Sun;
}

EarthSkyMath::FMoon EarthSkyMath::MoonAt(double Ms, double LatDeg, double LonDeg)
{
	const double N = DaysSince2000(Ms);
	const double T = N / 36525.0;
	const auto S = [T](double A, double B) { return FMath::Sin((A + B * T) * Rad); };
	const auto C = [T](double A, double B) { return FMath::Cos((A + B * T) * Rad); };
	const double LambdaDeg = TurnDeg(218.32 + 481267.881 * T
		+ 6.29 * S(135.0, 477198.87) - 1.27 * S(259.3, -413335.36) + 0.66 * S(235.7, 890534.22)
		+ 0.21 * S(269.9, 954397.74) - 0.19 * S(357.5, 35999.05) - 0.11 * S(186.5, 966404.03));
	const double BetaDeg = 5.13 * S(93.3, 483202.02) + 0.28 * S(228.2, 960400.89) - 0.28 * S(318.3, 6003.15) - 0.17 * S(217.6, -407332.21);
	// How big the Earth looks from the moon (its parallax), which says how far off it is.
	const double ParallaxDeg = 0.9508 + 0.0518 * C(135.0, 477198.87) + 0.0095 * C(259.3, -413335.36) + 0.0078 * C(235.7, 890534.22) + 0.0028 * C(269.9, 954397.74);
	double Ra = 0.0, Dec = 0.0;
	FromEcliptic(N, LambdaDeg, BetaDeg, Ra, Dec);
	FMoon Moon;
	Overhead(N, Ra, Dec, LatDeg, LonDeg, Moon.Alt, Moon.Az);
	Moon.Alt -= FMath::Asin(FMath::Sin(ParallaxDeg * Rad) * FMath::Cos(Moon.Alt)); // seen from the ground, not from the middle of the Earth
	// How far round from the sun it is: that is its phase.
	const double Ahead = TurnDeg(LambdaDeg - SunLongitudeDeg(N));
	const double Apart = FMath::Acos(FMath::Clamp(FMath::Cos(BetaDeg * Rad) * FMath::Cos(Ahead * Rad), -1.0, 1.0));
	Moon.Lit = (1.0 - FMath::Cos(Apart)) / 2.0;
	Moon.bWaxing = Ahead < 180.0;
	Moon.Age = Ahead / 360.0;
	return Moon;
}

const TCHAR* EarthSkyMath::MoonName(double Age)
{
	static const TCHAR* const Names[] = { TEXT("new moon"), TEXT("waxing crescent"), TEXT("first quarter"), TEXT("waxing gibbous"), TEXT("full moon"), TEXT("waning gibbous"), TEXT("last quarter"), TEXT("waning crescent") };
	return Names[FMath::RoundToInt32(TurnDeg(Age * 360.0) / 45.0) % 8];
}

FVector EarthSkyMath::Direction(double Alt, double Az)
{
	return FVector(FMath::Cos(Az) * FMath::Cos(Alt), FMath::Sin(Az) * FMath::Cos(Alt), FMath::Sin(Alt));
}

double EarthSkyMath::MomentOf(const FString& When, double Ms, double LatDeg, double LonDeg)
{
	constexpr double Step = 120000.0; // two minutes
	const double From = Ms - 12.0 * 3600000.0;
	double Top = From, Bottom = From, Most = -9.0, Least = 9.0;
	TArray<double> Alts;
	Alts.Reserve(721);
	for (int32 i = 0; i <= 720; ++i)
	{
		const double At = From + i * Step;
		const double Alt = SunAt(At, LatDeg, LonDeg).Alt;
		Alts.Add(Alt);
		if (Alt > Most) { Most = Alt; Top = At; }
		if (Alt < Least) { Least = Alt; Bottom = At; }
	}
	if (When == TEXT("noon")) { return Top; }
	if (When == TEXT("night")) { return Bottom; }
	// Low in the sky, with the day's colours at their warmest: four degrees up, or half way where it never gets there.
	const double Low = Most > 4.0 * Rad && Least < 4.0 * Rad ? 4.0 * Rad : (Most + Least) / 2.0;
	for (int32 i = 1; i < Alts.Num(); ++i)
	{
		const bool bRising = Alts[i - 1] < Low && Alts[i] >= Low, bSetting = Alts[i - 1] > Low && Alts[i] <= Low;
		if ((When == TEXT("morning") && bRising) || (When == TEXT("sunset") && bSetting))
		{
			return From + i * Step;
		}
	}
	return Top;
}

EarthSkyMath::FSun EarthSkyMath::FineDay()
{
	// The way the light has always gone in this game (the game mode's sun: pitch -36, yaw 135): from the north-west, 36 degrees up.
	FSun Sun;
	Sun.Alt = 36.0 * Rad;
	Sun.Az = 315.0 * Rad;
	return Sun;
}

EarthSkyMath::FLight EarthSkyMath::Light(const FSun& Sun, const FMoon* Moon, double InVeil, double InMist)
{
	const double Veil = FMath::Clamp(InVeil, 0.0, 1.0), Mist = FMath::Clamp(InMist, 0.0, 1.0);
	const double AltDeg = Sun.Alt / Rad;
	FLight L;
	L.Day = Smooth(-7.0, 5.0, AltDeg);
	L.Night = 1.0 - L.Day;
	// Warmest with the sun a degree or two up; gone by twelve degrees up and by nine degrees under.
	L.Dusk = AltDeg > 1.5 ? 1.0 - Smooth(1.5, 14.0, AltDeg) : Smooth(-9.0, 1.5, AltDeg);
	const auto Blend = [&L](FLinearColor FHour::* Part) { return Mix3(Mix3(NightHour.*Part, DayHour.*Part, L.Day), DuskHour.*Part, L.Dusk * 0.85); };
	const auto Air = [&L](FLinearColor FHour::* Part, double Much) { return Mix3(Mix3(NightHour.*Part, DayHour.*Part, L.Day), DuskHour.*Part, L.Dusk * Much); };
	// Overcast: the blue goes grey, as bright as the hour allows.
	const FLinearColor Grey = Mix3(FLinearColor(0.10f, 0.13f, 0.22f), FLinearColor(0.50f, 0.56f, 0.64f), L.Day);
	const auto Greyed = [&Grey, Veil](const FLinearColor& C, double Much) { return Mix3(C, Grey, Veil * Much); };

	const double MoonUp = Moon ? Smooth(-1.0, 6.0, Moon->Alt / Rad) : 0.0;
	const double MoonShine = Moon ? MoonUp * (0.4 + 0.6 * Moon->Lit) : 0.0;
	// The one light that casts: the sun down to a little under the horizon, then the moon, or the stars when there is none.
	const double SunStrength = StrengthSun * Smooth(HandoverDeg, 6.0, AltDeg) * (1.0 - 0.55 * Veil);
	const double After = 1.0 - Smooth(HandoverDeg - 5.0, HandoverDeg, AltDeg);
	if (AltDeg > HandoverDeg)
	{
		// Never from flatter than twelve degrees: a setting sun would leave the ground unlit, and this is a cartoon.
		L.From = 0;
		L.CastAlt = FMath::Max(Sun.Alt, 12.0 * Rad);
		L.CastAz = Sun.Az;
		L.CastColour = Blend(&FHour::Sun);
		L.CastStrength = SunStrength;
	}
	else if (Moon && MoonShine > 0.12)
	{
		L.From = 1;
		L.CastAlt = FMath::Max(Moon->Alt, 20.0 * Rad);
		L.CastAz = Moon->Az;
		L.CastColour = NightHour.Sun;
		L.CastStrength = After * Mix(StrengthStars, StrengthMoon, MoonShine) * (1.0 - 0.3 * Veil);
	}
	else
	{
		L.From = 2;
		L.CastAlt = 62.0 * Rad;
		L.CastAz = Sun.Az + UE_DOUBLE_PI;
		L.CastColour = NightHour.Sun;
		L.CastStrength = After * StrengthStars * (1.0 - 0.3 * Veil);
	}
	L.Land = Times(Greyed(Blend(&FHour::Land), 0.35), 1.0 - 0.18 * Veil);
	L.FogColour = Mix3(FLinearColor(0.16f, 0.20f, 0.30f), FLinearColor(0.74f, 0.78f, 0.80f), L.Day); // the white of a fog, by the hour
	L.Haze = Mix3(FLinearColor(0.36f * L.Land.R, 0.594f * L.Land.G, 0.594f * L.Land.B), L.FogColour, Mist);
	L.Zenith = Greyed(Air(&FHour::Zenith, 0.45), 0.9);
	L.Mid = Greyed(Air(&FHour::Mid, 0.8), 0.9);
	L.Horizon = Greyed(Air(&FHour::Horizon, 0.8), 0.8);
	L.FlatSky = Greyed(Blend(&FHour::Flat), 0.7);
	L.Glow = Times(FLinearColor(0.10f, 0.08f, 0.02f), L.Day * (1.0 - Veil));
	L.DuskGlow = Times(FLinearColor(0.55f, 0.20f, 0.04f), L.Dusk * (1.0 - 0.8 * Veil));
	L.SunDisc = Mix3(FLinearColor(1.f, 1.f, 1.f), FLinearColor(1.0f, 0.62f, 0.42f), Smooth(14.0, 0.0, AltDeg));
	L.SunShow = (1.0 - 0.9 * Veil) * (1.0 - Mist);
	L.Cloud = Times(Greyed(Blend(&FHour::Cloud), 0.55), 1.0 - 0.42 * Veil);
	L.CloudShade = Times(Greyed(Blend(&FHour::CloudShade), 0.5), 1.0 - 0.48 * Veil);
	L.Stars = Smooth(-3.0, -10.0, AltDeg) * (1.0 - Veil) * (1.0 - Mist);
	L.MoonShow = Moon ? Smooth(-2.0, 1.0, Moon->Alt / Rad) * Mix(1.0, 0.55, L.Day) * (1.0 - 0.8 * Veil) * (1.0 - Mist) : 0.0;
	L.MoonGlow = MoonShine * L.Night * (1.0 - Veil);
	L.Veil = Veil;
	L.Mist = Mist;
	L.Hour = Times(Blend(&FHour::Tint), 1.0 - 0.2 * Veil);
	L.SkyColour = Greyed(Blend(&FHour::Sky), 0.3);
	L.GroundColour = Blend(&FHour::Ground);
	L.SkyStrength = Mix(StrengthNightSky, StrengthSky, L.Day) * (1.0 - 0.1 * Veil);
	return L;
}

double EarthSkyMath::GroundLevel(const FLight& L)
{
	const auto Lum = [](const FLinearColor& C) { return 0.299 * C.R + 0.587 * C.G + 0.114 * C.B; };
	return Lum(L.SkyColour) * L.SkyStrength + Lum(L.CastColour) * L.CastStrength * FMath::Sin(L.CastAlt);
}

EarthSkyMath::FWeather EarthSkyMath::Fine()
{
	return FWeather();
}

bool EarthSkyMath::Try(const FString& Name, FWeather& Out)
{
	struct FRow { const TCHAR* Name; const TCHAR* Kind; double Cloud, Rain, Snow, Wind, Gust, WindFrom, Temp, Visibility; };
	static const FRow Rows[] = {
		{ TEXT("cloudy"), TEXT("cloudy"), 1.0, 0.0, 0.0, 4.0, 7.0, 250.0, 14.0, 20000.0 },
		{ TEXT("drizzle"), TEXT("drizzle"), 0.95, 0.4, 0.0, 3.0, 5.0, 250.0, 12.0, 8000.0 },
		{ TEXT("rain"), TEXT("rain"), 1.0, 4.0, 0.0, 6.0, 11.0, 250.0, 12.0, 6000.0 },
		{ TEXT("storm"), TEXT("storm"), 1.0, 9.0, 0.0, 12.0, 20.0, 250.0, 16.0, 3000.0 },
		{ TEXT("snow"), TEXT("snow"), 1.0, 0.0, 1.5, 3.0, 6.0, 200.0, -2.0, 1500.0 },
		{ TEXT("fog"), TEXT("fog"), 1.0, 0.0, 0.0, 1.0, 2.0, 200.0, 8.0, 200.0 },
		{ TEXT("windy"), TEXT("fine"), 0.45, 0.0, 0.0, 14.0, 22.0, 250.0, 15.0, 30000.0 },
	};
	for (const FRow& Row : Rows)
	{
		if (Name == Row.Name)
		{
			Out.Kind = Row.Kind;
			Out.Cloud = Row.Cloud;
			Out.Rain = Row.Rain;
			Out.Snow = Row.Snow;
			Out.Wind = Row.Wind;
			Out.Gust = Row.Gust;
			Out.WindFrom = Row.WindFrom;
			Out.Temp = Row.Temp;
			Out.Visibility = Row.Visibility;
			return true;
		}
	}
	return false;
}

FString EarthSkyMath::ParseWeather(const FString& Text)
{
	static const TCHAR* const Known[][2] = {
		{ TEXT("live"), TEXT("real") }, { TEXT("on"), TEXT("real") }, { TEXT("off"), TEXT("fine") }, { TEXT("sunny"), TEXT("fine") }, { TEXT("clear"), TEXT("fine") },
		{ TEXT("cloud"), TEXT("cloudy") }, { TEXT("clouds"), TEXT("cloudy") }, { TEXT("overcast"), TEXT("cloudy") }, { TEXT("raining"), TEXT("rain") },
		{ TEXT("snowing"), TEXT("snow") }, { TEXT("snowy"), TEXT("snow") }, { TEXT("foggy"), TEXT("fog") }, { TEXT("mist"), TEXT("fog") }, { TEXT("thunder"), TEXT("storm") }, { TEXT("wind"), TEXT("windy") },
	};
	FString Word = Text.TrimStartAndEnd().ToLower();
	for (const auto& Pair : Known)
	{
		if (Word == Pair[0])
		{
			Word = Pair[1];
			break;
		}
	}
	FWeather Unused;
	return Word == TEXT("real") || Word == TEXT("fine") || Try(Word, Unused) ? Word : FString();
}

FString EarthSkyMath::ParseTime(const FString& Text)
{
	static const TCHAR* const Known[][2] = {
		{ TEXT("real"), TEXT("real") }, { TEXT("live"), TEXT("real") }, { TEXT("now"), TEXT("real") }, { TEXT("day"), TEXT("day") }, { TEXT("daytime"), TEXT("day") },
		{ TEXT("always"), TEXT("day") }, { TEXT("fine"), TEXT("day") }, { TEXT("morning"), TEXT("morning") }, { TEXT("sunrise"), TEXT("morning") }, { TEXT("dawn"), TEXT("morning") },
		{ TEXT("noon"), TEXT("noon") }, { TEXT("midday"), TEXT("noon") }, { TEXT("sunset"), TEXT("sunset") }, { TEXT("evening"), TEXT("sunset") }, { TEXT("dusk"), TEXT("sunset") },
		{ TEXT("night"), TEXT("night") }, { TEXT("midnight"), TEXT("night") },
	};
	const FString Word = Text.TrimStartAndEnd().ToLower();
	for (const auto& Pair : Known)
	{
		if (Word == Pair[0])
		{
			return Pair[1];
		}
	}
	return FString();
}

EarthSkyMath::FWeatherLook EarthSkyMath::Look(const FWeather& W)
{
	const double Cloud = FMath::Clamp(W.Cloud, 0.0, 1.0);
	const double Rate = FMath::Max(0.0, W.Rain), Flakes = FMath::Max(0.0, W.Snow), Wind = FMath::Clamp(W.Wind, 0.0, 40.0);
	const bool bStorm = W.Kind == TEXT("storm");
	const bool bWet = W.Kind == TEXT("rain") || bStorm, bDrizzle = W.Kind == TEXT("drizzle"), bSnowing = W.Kind == TEXT("snow"), bFog = W.Kind == TEXT("fog");
	const double From = W.WindFrom * Rad;
	FWeatherLook L;
	L.Veil = Smooth(0.7, 1.0, Cloud) * 0.85;
	if (bStorm) { L.Veil = 1.0; }
	else if (bWet) { L.Veil = FMath::Max(L.Veil, 0.85); }
	else if (bSnowing) { L.Veil = FMath::Max(L.Veil, 0.75); }
	else if (bDrizzle) { L.Veil = FMath::Max(L.Veil, 0.7); }
	else if (bFog) { L.Veil = FMath::Max(L.Veil, 0.6); }
	if (bFog)
	{
		L.FogNear = 4.0;
		L.FogFar = FMath::Clamp((W.Visibility >= 0.0 ? W.Visibility : 300.0) * 0.5, 70.0, 260.0);
		L.Mist = 1.0;
	}
	else if (bSnowing)
	{
		L.FogNear = 60.0;
		L.FogFar = FMath::Clamp(900.0 - 150.0 * Flakes, 350.0, 900.0);
		L.Mist = 0.5;
	}
	else if (bWet || bDrizzle)
	{
		L.FogNear = 200.0;
		L.FogFar = FMath::Clamp(2200.0 - 220.0 * Rate, 900.0, 2200.0);
		L.Mist = FMath::Clamp(0.2 + 0.03 * Rate, 0.2, 0.45);
	}
	L.Clouds = FMath::Clamp((6.0 + Cloud * 100.0) / 100.0, 0.0, 1.0);
	if (bWet)
	{
		L.RainCount = FMath::RoundToInt32(FMath::Clamp(900.0 + 500.0 * Rate, 900.0, 4500.0));
		L.RainSpeed = bStorm ? 13.0 : 11.0;
	}
	else if (bDrizzle)
	{
		L.RainCount = FMath::RoundToInt32(FMath::Clamp(500.0 + 400.0 * Rate, 500.0, 1200.0));
		L.RainSpeed = 6.0;
		L.RainLength = 0.25;
		L.RainWidth = 0.011;
	}
	L.SnowCount = bSnowing ? FMath::RoundToInt32(FMath::Clamp(1200.0 + 1400.0 * Flakes, 1200.0, 4500.0)) : 0;
	L.Leaves = FMath::RoundToInt32(FMath::Clamp((Wind - 8.0) * 30.0, 0.0, 240.0));
	L.WindEast = -FMath::Sin(From) * Wind;
	L.WindSouth = FMath::Cos(From) * Wind;
	L.Drift = 0.4 + Wind / 4.0;
	L.Sway = FMath::Clamp(0.03 + 0.02 * Wind, 0.03, 0.4);
	L.RainSound = bWet ? FMath::Clamp(0.35 + 0.08 * Rate, 0.0, 1.0) : bDrizzle ? 0.2 : 0.0;
	L.WindSound = FMath::Clamp((Wind - 2.5) / 12.0, 0.0, 1.0);
	L.bThunder = bStorm;
	return L;
}

FString EarthSkyMath::WeatherSaid(const FWeather& W)
{
	const FString Sky = W.Kind == TEXT("cloudy") ? TEXT("cloudy") : W.Kind == TEXT("fog") ? TEXT("fog") : W.Kind == TEXT("drizzle") ? TEXT("drizzle")
		: W.Kind == TEXT("rain") ? (W.Rain >= 6.0 ? TEXT("heavy rain") : TEXT("rain")) : W.Kind == TEXT("snow") ? TEXT("snow") : W.Kind == TEXT("storm") ? TEXT("a thunderstorm")
		: W.Cloud < 0.3 ? TEXT("a clear sky") : TEXT("sunshine and some cloud");
	const TCHAR* Breeze = W.Wind >= 14.0 ? TEXT("a gale") : W.Wind >= 9.0 ? TEXT("a strong wind") : W.Wind >= 5.0 ? TEXT("a breeze") : TEXT("hardly any wind");
	const FString From = W.Wind >= 5.0 ? FString::Printf(TEXT(" from the %s"), Points[FMath::RoundToInt32(TurnDeg(W.WindFrom) / 45.0) % 8]) : FString();
	return FString::Printf(TEXT("%s, %d degrees, %s%s"), *Sky, FMath::RoundToInt32(W.Temp), Breeze, *From);
}

FString EarthSkyMath::SkySaid(const FSun& Sun, const FMoon* Moon, const FString& Trying)
{
	if (!Moon)
	{
		return TEXT("It is always a fine day here. /time real follows the real sun and moon over wherever you are.");
	}
	const auto Where = [](double Az) { return Points[FMath::RoundToInt32((Az / Rad) / 45.0) % 8]; };
	const double Up = Sun.Alt / Rad;
	const FString SunSaid = Up > 6.0 ? FString::Printf(TEXT("the sun is %d degrees up in the %s"), FMath::RoundToInt32(Up), Where(Sun.Az))
		: Up > -1.0 ? FString::Printf(TEXT("the sun is on the horizon in the %s"), Where(Sun.Az)) : Up > -8.0 ? FString(TEXT("the sun has just gone under: twilight")) : FString(TEXT("it is night"));
	const FString MoonSaid = Moon->Alt > 0.0 ? FString::Printf(TEXT("the moon is up in the %s: a %s"), Where(Moon->Az), MoonName(Moon->Age))
		: FString::Printf(TEXT("the moon (a %s) is under the horizon"), MoonName(Moon->Age));
	return FString::Printf(TEXT("%s: %s, and %s."), Trying.IsEmpty() ? TEXT("The real sky here") : *FString::Printf(TEXT("Trying out %s"), *Trying), *SunSaid, *MoonSaid);
}

void EarthSkyMath::Check()
{
	struct FCase { const TCHAR* What; double Ms, Lat, Lon; };
	static const FCase Cases[] = {
		{ TEXT("Auckland, 24 November 2026, 00:00 UTC"), 1795478400000.0, -36.85, 174.76 },
		{ TEXT("Mexico, the eclipse of 8 April 2024, 18:18 UTC"), 1712600280000.0, 25.29, -104.14 },
		{ TEXT("London, 21 June 2026, 12:00 UTC"), 1782043200000.0, 51.5, -0.12 },
		{ TEXT("Auckland, 24 November 2026, 11:00 UTC"), 1795518000000.0, -36.85, 174.76 },
	};
	for (const FCase& Case : Cases)
	{
		const FSun Sun = SunAt(Case.Ms, Case.Lat, Case.Lon);
		const FMoon Moon = MoonAt(Case.Ms, Case.Lat, Case.Lon);
		const FLight L = Light(Sun, &Moon, 0.0, 0.0);
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: sky check: %s: sun alt %.3f az %.3f; moon alt %.3f az %.3f lit %.4f age %.4f; day %.3f dusk %.3f from %d cast %.3f zenith %.3f %.3f %.3f ground %.3f"),
			Case.What, Sun.Alt / Rad, Sun.Az / Rad, Moon.Alt / Rad, Moon.Az / Rad, Moon.Lit, Moon.Age, L.Day, L.Dusk, L.From, L.CastStrength, L.Zenith.R, L.Zenith.G, L.Zenith.B, GroundLevel(L));
	}
}
