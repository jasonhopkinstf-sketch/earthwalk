#include "EarthWeather.h"

#include "Camera/PlayerCameraManager.h"
#include "Components/AudioComponent.h"
#include "Dom/JsonObject.h"
#include "EarthLife.h"
#include "EarthSky.h"
#include "EarthSounds.h"
#include "EarthWalkGameMode.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Sound/SoundWaveProcedural.h"

namespace
{
	// The box round the camera that rain and snow fall through, in metres (FALL_BOX in weatherdata.js): across, up and down, across.
	constexpr double BoxWide = 30.0, BoxHigh = 20.0;
	// How often the server is asked again, and how soon after it had nothing to give: seconds.
	constexpr double AskEveryS = 600.0, AskAfterFailS = 120.0;

	/** A number of its own for each streak and flake, 0 to 1. */
	double Own(int32 Index, int32 Which)
	{
		uint32 H = static_cast<uint32>(Index) * 0x9e3779b1u ^ (static_cast<uint32>(Which) + 0x7f4a7c15u) * 0x85ebca6bu;
		H ^= H >> 15;
		H *= 0x2c1b3c6du;
		H ^= H >> 12;
		return (H & 0xffffff) / 16777216.0;
	}
	/** Wraps a place along one axis into the box round the camera: what leaves one side comes in at the other. */
	double InBox(double Place, double Camera, double Size)
	{
		double Off = FMath::Fmod(Place - Camera + Size * 0.5, Size);
		if (Off < 0.0)
		{
			Off += Size;
		}
		return Camera + Off - Size * 0.5;
	}
}

void UEarthWeather::Setup(AEarthWalkHUD* InHud)
{
	Hud = InHud;
	// The settings as kept, or as -EWTime= and -EWWeather= ask for one run: a setting, or something to try out.
	FString Asked;
	if (FEarthWalkConfig::HasOverride(TEXT("Time"), Asked))
	{
		const FString Time = EarthSkyMath::ParseTime(Asked);
		if (Time == TEXT("real") || Time == TEXT("day"))
		{
			TimeSetting = Time;
		}
		else if (!Time.IsEmpty())
		{
			TimeTrying = Time; // the moment is worked out once the place is known
		}
	}
	if (FEarthWalkConfig::HasOverride(TEXT("Weather"), Asked))
	{
		const FString Weather = EarthSkyMath::ParseWeather(Asked);
		if (Weather == TEXT("real") || Weather == TEXT("fine"))
		{
			WeatherSetting = Weather;
		}
		else if (EarthSkyMath::Try(Weather, Tried))
		{
			WeatherTrying = Weather;
		}
	}
	if (FParse::Param(FCommandLine::Get(), TEXT("EWSkyCheck")))
	{
		EarthSkyMath::Check();
	}
}

double UEarthWeather::NowMs() const
{
	return static_cast<double>(FDateTime::UtcNow().ToUnixTimestamp()) * 1000.0 + FDateTime::UtcNow().GetMillisecond();
}

const EarthSkyMath::FWeather& UEarthWeather::Showing() const
{
	static const EarthSkyMath::FWeather FineDay = EarthSkyMath::Fine();
	if (!WeatherTrying.IsEmpty())
	{
		return Tried;
	}
	return WeatherSetting == TEXT("real") && bHaveReport ? Report : FineDay;
}

void UEarthWeather::Frame(float DeltaSeconds)
{
	AEarthWalkHUD* Screen = Hud.Get();
	UWorld* World = Screen ? Screen->GetWorld() : nullptr;
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	const AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const AEarthWorld* Earth = World ? AEarthWorld::Get(World) : nullptr;
	if (!Me || !Earth)
	{
		return;
	}
	Clock += DeltaSeconds;
	double Lat = 0.0, Lon = 0.0, Alt = 0.0;
	Earth->WorldToGeo(Me->GetActorLocation(), Lat, Lon, Alt);
	bLanded = bLanded || !Me->IsWaitingForGround();

	// The weather of the district: asked for on arriving, when the district changes, and every ten minutes.
	if (WeatherSetting == TEXT("real") && bLanded && !bAsking)
	{
		const FString Area = FString::Printf(TEXT("%.2f,%.2f"), FMath::RoundToDouble(Lat * 4.0) / 4.0, FMath::RoundToDouble(Lon * 4.0) / 4.0);
		if (Area != AskedArea || Clock > AskAgainAt)
		{
			AskedArea = Area;
			Ask(FMath::RoundToDouble(Lat * 4.0) / 4.0, FMath::RoundToDouble(Lon * 4.0) / 4.0);
		}
	}

	// A few times a second: where the sun and moon stand, and the light. (The numbers ease every frame.)
	SinceWork += DeltaSeconds;
	Work(NowMs(), Lat, Lon, DeltaSeconds);
	Fall(DeltaSeconds);
	Sound(DeltaSeconds);
}

void UEarthWeather::Ask(double Lat, double Lon)
{
	bAsking = true;
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("%s/v1/weather?lat=%.2f&lon=%.2f"), *FEarthWalkConfig::ServerUrl(), Lat, Lon));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(30.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		bAsking = false;
		TSharedPtr<FJsonObject> Json;
		FString Kind;
		// Anything but a good answer is a fine day, silently.
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200
			&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Json) && Json.IsValid() && Json->TryGetStringField(TEXT("kind"), Kind))
		{
			EarthSkyMath::FWeather Got;
			Got.Kind = Kind;
			Json->TryGetNumberField(TEXT("cloud"), Got.Cloud);
			Json->TryGetNumberField(TEXT("rain"), Got.Rain);
			Json->TryGetNumberField(TEXT("snow"), Got.Snow);
			Json->TryGetNumberField(TEXT("wind"), Got.Wind);
			Json->TryGetNumberField(TEXT("gust"), Got.Gust);
			Json->TryGetNumberField(TEXT("windFrom"), Got.WindFrom);
			Json->TryGetNumberField(TEXT("temp"), Got.Temp);
			if (!Json->TryGetNumberField(TEXT("visibility"), Got.Visibility))
			{
				Got.Visibility = -1.0;
			}
			Report = Got;
			bHaveReport = true;
			AskAgainAt = Clock + AskEveryS;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: weather: %s"), *EarthSkyMath::WeatherSaid(Got));
		}
		else
		{
			bHaveReport = false;
			AskAgainAt = Clock + AskAfterFailS;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: weather: none to be had (answer %d): a fine day"), Response.IsValid() ? Response->GetResponseCode() : 0);
		}
	});
	Request->ProcessRequest();
}

void UEarthWeather::Work(double Ms, double Lat, double Lon, float DeltaSeconds)
{
	AEarthWalkHUD* Screen = Hud.Get();
	AEarthSky* Sky = Screen ? AEarthSky::Get(Screen->GetWorld()) : nullptr;
	if (!Sky)
	{
		return;
	}
	// The weather's numbers ease to where they should be over about two and a half seconds.
	const EarthSkyMath::FWeatherLook Want = EarthSkyMath::Look(Showing());
	if (!bStarted)
	{
		bStarted = true;
		Now = Want;
	}
	const double Step = 1.0 - FMath::Exp(-1.2 * DeltaSeconds);
	const auto Ease = [Step](double& Value, double To) { Value += (To - Value) * Step; };
	Ease(Now.Clouds, Want.Clouds);
	Ease(Now.Veil, Want.Veil);
	Ease(Now.Mist, Want.Mist);
	Ease(Now.FogNear, Want.FogNear);
	Ease(Now.FogFar, Want.FogFar);
	Ease(Now.WindEast, Want.WindEast);
	Ease(Now.WindSouth, Want.WindSouth);
	Ease(Now.Drift, Want.Drift);
	Ease(Now.RainSound, Want.RainSound);
	Ease(Now.WindSound, Want.WindSound);
	Now.RainCount = Want.RainCount;
	Now.RainSpeed = Want.RainSpeed;
	Now.RainLength = Want.RainLength;
	Now.RainWidth = Want.RainWidth;
	Now.SnowCount = Want.SnowCount;
	Now.bThunder = Want.bThunder;
	// (The clouds cross at 0.0025 radians a second on a fine day: M_EarthSky's Drift. The wind adds to that or takes from it.)
	DriftAt += (Now.Drift - 1.0) * 0.0025 * DeltaSeconds;

	// A storm: every seven to twenty-one seconds a flash, twice, gone in a quarter of a second.
	if (Now.bThunder)
	{
		FlashIn -= DeltaSeconds;
		if (FlashIn <= 0.0)
		{
			Flash = 1.0;
			if (FlashesLeft > 0)
			{
				--FlashesLeft;
				FlashIn = FlashesLeft > 0 ? 0.3 : 7.0 + 14.0 * FMath::FRand();
			}
			else
			{
				FlashesLeft = 1;
				FlashIn = 0.3;
				ThunderIn = 0.6 + 2.2 * FMath::FRand(); // the thunder follows the flash
			}
		}
	}
	const bool bFlashing = Flash > 0.001;
	Flash = FMath::Max(0.0, Flash - DeltaSeconds * 4.0);

	if (SinceWork < 0.2 && !bFlashing)
	{
		return;
	}
	SinceWork = 0.0;
	// A time of day being tried out is a moment of the real day over this place.
	if (!TimeTrying.IsEmpty() && AheadMs == 0.0 && bLanded)
	{
		AheadMs = EarthSkyMath::MomentOf(TimeTrying, Ms, Lat, Lon) - Ms;
	}
	const bool bFine = TimeSetting == TEXT("day") && TimeTrying.IsEmpty();
	const double At = Ms + AheadMs;
	LastSun = bFine ? EarthSkyMath::FineDay() : EarthSkyMath::SunAt(At, Lat, Lon);
	bMoon = !bFine;
	if (bMoon)
	{
		LastMoon = EarthSkyMath::MoonAt(At, Lat, Lon);
	}
	const EarthSkyMath::FLight Light = EarthSkyMath::Light(LastSun, bMoon ? &LastMoon : nullptr, Now.Veil, Now.Mist);
	LastNight = Light.Night;
	const FVector ToSun = EarthSkyMath::Direction(LastSun.Alt, LastSun.Az);
	const FVector ToMoon = bMoon ? EarthSkyMath::Direction(LastMoon.Alt, LastMoon.Az) : FVector::UpVector;
	Sky->PaintHour(Light, ToSun, bMoon ? &ToMoon : nullptr, Now.Clouds, DriftAt, Now.FogNear, Now.FogFar, Flash);
	if (AEarthWalkGameMode* Mode = Screen->GetWorld()->GetAuthGameMode<AEarthWalkGameMode>())
	{
		Mode->SetAir(Now.Mist, Now.FogNear, Now.FogFar, Light.Night, Light.Hour);
	}

	// Under a roof or in a tunnel nothing falls: is there anything over the player's head?
	if (const APlayerController* PC = Screen->GetOwningPlayerController())
	{
		if (const APawn* Pawn = PC->GetPawn())
		{
			FHitResult Hit;
			FCollisionQueryParams Params(SCENE_QUERY_STAT(EarthWeatherRoof), false, Pawn);
			const FVector Head = Pawn->GetActorLocation() + FVector(0.0, 0.0, 60.0);
			bUnderCover = Screen->GetWorld()->LineTraceSingleByChannel(Hit, Head, Head + FVector(0.0, 0.0, 3000.0), ECC_Visibility, Params);
		}
	}
}

/** Rain and snow: each streak and flake has a place of its own in the world, wrapped into a box that stays round the camera. */
void UEarthWeather::Fall(float DeltaSeconds)
{
	AEarthWalkHUD* Screen = Hud.Get();
	AEarthSky* Sky = Screen ? AEarthSky::Get(Screen->GetWorld()) : nullptr;
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	if (!Sky || !PC || !PC->PlayerCameraManager)
	{
		return;
	}
	const FVector Camera = PC->PlayerCameraManager->GetCameraLocation() / 100.0; // metres: X north, Y east, Z up
	const int32 RainCount = bUnderCover ? 0 : Now.RainCount, SnowCount = bUnderCover ? 0 : Now.SnowCount;
	const double T = Clock;
	const double WindNorth = -Now.WindSouth, WindEast = Now.WindEast;

	Rain.SetNum(RainCount, EAllowShrinking::No);
	if (RainCount > 0)
	{
		static const double Paces[] = { 0.75, 1.0, 1.25, 1.5 };
		// A streak lies along the way it falls: down, and sideways with the wind.
		const FVector Going(WindNorth * 0.8, WindEast * 0.8, -Now.RainSpeed);
		const FQuat Lean = FRotationMatrix::MakeFromZ(-Going.GetSafeNormal()).ToQuat();
		// (A little wider than the browser's: a line thinner than a dot of the screen flickers here.)
		const FVector Size(FMath::Max(Now.RainWidth, 0.022), FMath::Max(Now.RainWidth, 0.022), Now.RainLength);
		for (int32 i = 0; i < RainCount; ++i)
		{
			const double Pace = Paces[i & 3];
			const double X = InBox(Own(i, 1) * BoxWide + Going.X * Pace * T, Camera.X, BoxWide);
			const double Y = InBox(Own(i, 2) * BoxWide + Going.Y * Pace * T, Camera.Y, BoxWide);
			const double Z = InBox(Own(i, 3) * BoxHigh + Going.Z * Pace * T, Camera.Z, BoxHigh);
			// None right in front of the eyes.
			const bool bNear = FMath::Square(X - Camera.X) + FMath::Square(Y - Camera.Y) + FMath::Square(Z - Camera.Z) < 1.8 * 1.8;
			Rain[i] = FTransform(Lean, FVector(X, Y, Z) * 100.0, bNear ? FVector::ZeroVector : Size);
		}
	}
	Snow.SetNum(SnowCount, EAllowShrinking::No);
	if (SnowCount > 0)
	{
		const FQuat Tipped = FRotator(45.0, 45.0, 0.0).Quaternion();
		const FVector Size(Now.SnowSize * 0.9);
		for (int32 i = 0; i < SnowCount; ++i)
		{
			const double Wander = Now.SnowSway * FMath::Sin(T * (0.5 + Own(i, 4)) + Own(i, 5) * 40.0);
			const double X = InBox(Own(i, 1) * BoxWide + WindNorth * 0.6 * T + Wander, Camera.X, BoxWide);
			const double Y = InBox(Own(i, 2) * BoxWide + WindEast * 0.6 * T + Wander * 0.6, Camera.Y, BoxWide);
			const double Z = InBox(Own(i, 3) * BoxHigh - Now.SnowSpeed * (0.8 + 0.4 * Own(i, 6)) * T, Camera.Z, BoxHigh);
			const bool bNear = FMath::Square(X - Camera.X) + FMath::Square(Y - Camera.Y) + FMath::Square(Z - Camera.Z) < 2.2 * 2.2;
			Snow[i] = FTransform(Tipped, FVector(X, Y, Z) * 100.0, bNear ? FVector::ZeroVector : Size);
		}
	}
	// The rain is dimmed to two fifths at night, the snow to a moonlit blue.
	const float Dim = static_cast<float>(FMath::Lerp(1.0, 0.4, LastNight));
	Sky->SetFall(Rain, Snow, FLinearColor(0.62f, 0.74f, 0.92f) * Dim, FLinearColor::LerpUsingHSV(FLinearColor(1.f, 1.f, 1.f), FLinearColor(0.55f, 0.62f, 0.85f), static_cast<float>(LastNight)));
}

/**
 * Rain, wind and thunder, from hiss (the recipes of weather.js): the rain a hiss with its lowest and highest parts
 * taken off, the wind a narrow band of hiss whose pitch wanders and which gusts, the thunder a hiss that grows
 * deeper as it rolls away. Under a roof the rain is duller and quieter and the wind a third as loud.
 */
void UEarthWeather::Sound(float DeltaSeconds)
{
	AEarthWalkHUD* Screen = Hud.Get();
	if (!Screen)
	{
		return;
	}
	constexpr int32 Rate = 22050;
	const AEarthWorld* Earth = AEarthWorld::Get(Screen->GetWorld());
	const UEarthSounds* Sounds = Earth && Earth->GetLife() ? Earth->GetLife()->GetSounds() : nullptr;
	const bool bOn = !Sounds || Sounds->IsEnabled();
	const double RainWant = bOn ? Now.RainSound * (bUnderCover ? 0.5 : 1.0) : 0.0;
	const double WindWant = bOn ? Now.WindSound * (bUnderCover ? 1.0 / 3.0 : 1.0) : 0.0;
	if (ThunderIn >= 0.0)
	{
		ThunderIn -= DeltaSeconds;
		if (ThunderIn < 0.0 && bOn)
		{
			ThunderAt = 0.0;
		}
	}
	const bool bQuiet = RainWant < 0.002 && WindWant < 0.002 && RainGain < 0.002 && WindGain < 0.002 && ThunderAt < 0.0;
	if (bQuiet)
	{
		return; // nothing to hear: nothing is worked out
	}
	if (!Stream)
	{
		Stream = NewObject<USoundWaveProcedural>(this);
		Stream->SetSampleRate(Rate);
		Stream->NumChannels = 1;
		Stream->Duration = INDEFINITELY_LOOPING_DURATION;
		Stream->SoundGroup = SOUNDGROUP_Default;
		Stream->bLooping = false;
		Voice = NewObject<UAudioComponent>(Screen);
		Voice->bAllowSpatialization = false;
		Voice->bAutoDestroy = false;
		Voice->RegisterComponent();
		Voice->SetSound(Stream);
	}
	if (!Voice->IsPlaying())
	{
		Voice->Play();
	}
	// A third of a second is kept ready, worked out a tenth of a second at a time.
	constexpr int32 Chunk = Rate / 10;
	const double RainTop = bUnderCover ? 800.0 : 6500.0;
	const double RainK = 1.0 - FMath::Exp(-UE_DOUBLE_TWO_PI * RainTop / Rate);
	const double HighA = 1.0 / (1.0 + UE_DOUBLE_TWO_PI * 700.0 / Rate);
	TArray<int16> Samples;
	while (Stream->GetAvailableAudioByteCount() < Rate * 2 / 3)
	{
		Samples.SetNumUninitialized(Chunk, EAllowShrinking::No);
		for (int32 i = 0; i < Chunk; ++i)
		{
			const auto Noise = [this]()
			{
				Hiss = Hiss * 1664525u + 1013904223u;
				return static_cast<double>(Hiss >> 8) / 8388608.0 - 1.0;
			};
			SoundClock += 1.0 / Rate;
			RainGain += (RainWant - RainGain) * 0.0002;
			WindGain += (WindWant - WindGain) * 0.0002;
			// Rain.
			const double In = Noise();
			RainHigh = HighA * (RainHigh + In - RainWas);
			RainWas = In;
			RainLow += (RainHigh - RainLow) * RainK;
			double Out = RainLow * RainGain * 0.16 * 2.2;
			// Wind: a band of hiss at about 420 Hz that wanders, and gusts.
			const double Pitch = 420.0 + 170.0 * FMath::Sin(UE_DOUBLE_TWO_PI * 0.11 * SoundClock) + 90.0 * FMath::Sin(UE_DOUBLE_TWO_PI * 0.29 * SoundClock);
			const double F = 2.0 * FMath::Sin(UE_DOUBLE_PI * Pitch / Rate);
			WindLow += F * WindBand;
			const double High = Noise() - WindLow - WindBand / 0.9;
			WindBand += F * High;
			Out += WindBand * WindGain * 0.22 * (1.0 + 0.3 * FMath::Sin(UE_DOUBLE_TWO_PI * 0.17 * SoundClock)) * 0.9;
			// Thunder: a deep hiss that grows deeper, loud at once and rolling away.
			if (ThunderAt >= 0.0)
			{
				const double Top = 260.0 * FMath::Pow(70.0 / 260.0, FMath::Min(ThunderAt / 2.9, 1.0));
				const double K = 1.0 - FMath::Exp(-UE_DOUBLE_TWO_PI * Top / Rate);
				ThunderLow += (Noise() - ThunderLow) * K;
				ThunderLower += (ThunderLow - ThunderLower) * K;
				const double Loud = FMath::Min(ThunderAt / 0.05, 1.0) * FMath::Exp(-ThunderAt / 1.1) * (0.75 + 0.25 * FMath::Sin(ThunderAt * 19.0));
				Out += ThunderLower * Loud * 5.5;
				ThunderAt += 1.0 / Rate;
				if (ThunderAt > 3.4)
				{
					ThunderAt = -1.0;
				}
			}
			Samples[i] = static_cast<int16>(FMath::Clamp(Out, -1.0, 1.0) * 30000.0);
		}
		Stream->QueueAudio(reinterpret_cast<const uint8*>(Samples.GetData()), Samples.Num() * sizeof(int16));
	}
}

FString UEarthWeather::TimeCommand(const FString& Argument)
{
	const FString Asked = EarthSkyMath::ParseTime(Argument);
	const FString Said = EarthSkyMath::SkySaid(LastSun, bMoon ? &LastMoon : nullptr, TimeTrying);
	if (Asked.IsEmpty())
	{
		return Said + TEXT(" /time real   the real sun and moon        /time day   always daytime        /time morning, noon, sunset or night   try one out");
	}
	if (Asked == TEXT("real") || Asked == TEXT("day"))
	{
		TimeSetting = Asked;
		TimeTrying.Reset();
		AheadMs = 0.0;
		FEarthWalkConfig::Save(TEXT("Time"), Asked);
		SinceWork = 1.0;
		return Asked == TEXT("day") ? FString(TEXT("Always daytime now. /time real goes back to the real sun and moon."))
			: FString(TEXT("The real sun and moon over wherever you are. /time day goes back to always daytime; /time says where they stand."));
	}
	if (!bLanded)
	{
		return TEXT("Wait until you have landed, then try again.");
	}
	TimeTrying = Asked;
	AheadMs = 0.0; // worked out at the next look at the sky
	SinceWork = 1.0;
	return FString::Printf(TEXT("Trying out %s, for now. /time real goes back to the real sun and moon."), *Asked);
}

FString UEarthWeather::WeatherCommand(const FString& Argument)
{
	const FString Asked = EarthSkyMath::ParseWeather(Argument);
	if (Asked.IsEmpty())
	{
		return FString::Printf(TEXT("%s: %s. /weather real   the real weather        /weather fine   always a fine day        /weather rain, snow, fog, cloudy, storm, drizzle or windy   try one out"),
			!WeatherTrying.IsEmpty() ? *FString::Printf(TEXT("Trying out %s"), *WeatherTrying) : ShowsRealWeather() ? TEXT("The real weather here") : TEXT("A fine day"), *EarthSkyMath::WeatherSaid(Showing()));
	}
	if (Asked == TEXT("real") || Asked == TEXT("fine"))
	{
		WeatherSetting = Asked;
		WeatherTrying.Reset();
		FEarthWalkConfig::Save(TEXT("Weather"), Asked);
		AskedArea.Reset(); // asked for afresh
		return Asked == TEXT("real") ? FString(TEXT("The real weather of wherever you are. /weather fine goes back to a fine day."))
			: FString(TEXT("A fine day, whatever the weather. /weather real goes back to the real weather."));
	}
	EarthSkyMath::Try(Asked, Tried);
	WeatherTrying = Asked;
	return FString::Printf(TEXT("Trying out %s: %s. /weather real goes back to the real weather."), *Asked, *EarthSkyMath::WeatherSaid(Tried));
}

FString UEarthWeather::ToggleTime()
{
	return TimeCommand(TimeSetting == TEXT("real") && TimeTrying.IsEmpty() ? TEXT("day") : TEXT("real"));
}

FString UEarthWeather::ToggleWeather()
{
	return WeatherCommand(WeatherSetting == TEXT("real") && WeatherTrying.IsEmpty() ? TEXT("fine") : TEXT("real"));
}
