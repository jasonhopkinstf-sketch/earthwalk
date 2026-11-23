#pragma once

#include "CoreMinimal.h"
#include "EarthSkyMath.h"
#include "UObject/Object.h"
#include "EarthWeather.generated.h"

class AEarthWalkHUD;
class UAudioComponent;
class USoundWaveProcedural;

/**
 * The hour and the weather (the Windows counterpart of daynight.js and weather.js in server/public/js;
 * docs/PROTOCOL.md, "The weather"). The sun and the moon stand where they really are over the place the
 * player is in, worked out here from the clock; the weather is asked of the server for the district
 * (a quarter of a degree, nothing finer) on arriving, when the district changes and every ten minutes.
 * Anything but a good answer is a fine day, and nothing is said of it. Every number eases to its new
 * value, so the weather turns and does not snap.
 *
 * What it draws, through AEarthSky: the colours of the air, the sun, the moon with its real phase, stars,
 * how many clouds there are and how fast they cross, the one light that casts, the light from all round
 * (a bright night, never black), the haze, rain and snow in a box that stays round the camera, and a
 * flash now and then in a storm. And what is heard, made from hiss like every sound here (no recordings): rain,
 * wind and thunder, in one stream of sound worked out a tenth of a second at a time.
 *
 * Two settings, kept: Time (real, or day: always the fine day) and Weather (real, or fine). /time and
 * /weather set them, or try a time of day or a kind of weather out for this run; -EWTime= and
 * -EWWeather= do the same for one run, for pictures.
 */
UCLASS()
class UEarthWeather : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	/** Every frame, from the screen's own Tick. */
	void Frame(float DeltaSeconds);

	/** "/time ..." as typed: does it, and returns what to say. */
	FString TimeCommand(const FString& Argument);
	/** "/weather ..." as typed. */
	FString WeatherCommand(const FString& Argument);
	/** The menu's rows: the real time of day or always daytime, the real weather or a fine day. */
	FString ToggleTime();
	FString ToggleWeather();
	/** The real weather is what is being drawn: the credit line then names where it comes from. */
	bool ShowsRealWeather() const { return bHaveReport && WeatherSetting == TEXT("real") && WeatherTrying.IsEmpty(); }

private:
	void Ask(double Lat, double Lon);
	void Work(double NowMs, double Lat, double Lon, float DeltaSeconds);
	void Fall(float DeltaSeconds);
	void Sound(float DeltaSeconds);
	const EarthSkyMath::FWeather& Showing() const;
	double NowMs() const;

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	FString TimeSetting = TEXT("real");
	FString TimeTrying;   // morning, noon, sunset or night, for this run
	double AheadMs = 0.0; // how far the pretended clock is from the real one
	FString WeatherSetting = TEXT("real");
	FString WeatherTrying; // a kind of weather, for this run
	EarthSkyMath::FWeather Tried;

	// What the server last said, for which district, and when to ask again.
	EarthSkyMath::FWeather Report;
	bool bHaveReport = false;
	FString AskedArea;
	double AskAgainAt = 0.0;
	bool bAsking = false;

	// What is drawn: every number easing towards what the weather says.
	EarthSkyMath::FWeatherLook Now;
	bool bStarted = false;
	double DriftAt = 0.0;
	double SinceWork = 1.0;
	bool bLanded = false;
	bool bUnderCover = false;
	double Clock = 0.0;
	// A storm: when the next flash comes, and how bright the one now is.
	double FlashIn = 9.0;
	double Flash = 0.0;
	int32 FlashesLeft = 0;
	// Where the sun and the moon last stood, for /time to say.
	EarthSkyMath::FSun LastSun;
	EarthSkyMath::FMoon LastMoon;
	bool bMoon = false;
	double LastNight = 0.0;
	TArray<FTransform> Rain;
	TArray<FTransform> Snow;

	// What is heard.
	UPROPERTY()
	TObjectPtr<UAudioComponent> Voice;
	UPROPERTY()
	TObjectPtr<USoundWaveProcedural> Stream;
	uint32 Hiss = 0x1234abcdu;
	double RainGain = 0.0, WindGain = 0.0;
	double RainWas = 0.0, RainHigh = 0.0, RainLow = 0.0; // the rain's two filters, from one sample to the next
	double WindLow = 0.0, WindBand = 0.0;
	double ThunderIn = -1.0; // seconds until the thunder of the last flash; below 0 for none coming
	double ThunderAt = -1.0; // seconds into a clap of thunder; below 0 for none
	double ThunderLow = 0.0, ThunderLower = 0.0;
	double SoundClock = 0.0;
};
