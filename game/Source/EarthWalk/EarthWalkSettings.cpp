#include "EarthWalkSettings.h"

#include "Misc/CommandLine.h"
#include "Misc/ConfigCacheIni.h"
#include "Misc/Parse.h"

static const TCHAR* const UserSection = TEXT("EarthWalk");

bool FEarthWalkConfig::Lookup(const TCHAR* Key, FString& Out)
{
	if (FParse::Value(FCommandLine::Get(), *FString::Printf(TEXT("-EW%s="), Key), Out) && !Out.IsEmpty())
	{
		return true;
	}
	return GConfig && GConfig->GetString(UserSection, Key, Out, GGameUserSettingsIni) && !Out.IsEmpty();
}

void FEarthWalkConfig::Save(const TCHAR* Key, const FString& Value)
{
	if (GConfig)
	{
		GConfig->SetString(UserSection, Key, *Value, GGameUserSettingsIni);
		GConfig->Flush(false, GGameUserSettingsIni);
	}
}

FString FEarthWalkConfig::ServerUrl()
{
	FString Value;
	if (!Lookup(TEXT("Server"), Value))
	{
		Value = GetDefault<UEarthWalkSettings>()->ServerUrl;
	}
	Value.TrimStartAndEndInline();
	while (Value.EndsWith(TEXT("/")))
	{
		Value.LeftChopInline(1);
	}
	return Value;
}

FString FEarthWalkConfig::PlayerName()
{
	FString Value;
	return Lookup(TEXT("Name"), Value) ? Value : GetDefault<UEarthWalkSettings>()->PlayerName;
}

FString FEarthWalkConfig::Room()
{
	FString Value;
	return Lookup(TEXT("Room"), Value) ? Value : GetDefault<UEarthWalkSettings>()->Room;
}

FString FEarthWalkConfig::Avatar()
{
	FString Value;
	return (Lookup(TEXT("Avatar"), Value) ? Value : GetDefault<UEarthWalkSettings>()->Avatar).ToLower();
}

FString FEarthWalkConfig::SharedCode()
{
	FString Value;
	return Lookup(TEXT("Code"), Value) ? Value : GetDefault<UEarthWalkSettings>()->AccessCode;
}

FString FEarthWalkConfig::PlayerToken()
{
	FString Value;
	return Lookup(TEXT("Token"), Value) ? Value : FString();
}

FString FEarthWalkConfig::MapsKey()
{
	FString Value;
	if (!Lookup(TEXT("MapsKey"), Value))
	{
		Value = GetDefault<UEarthWalkSettings>()->GoogleMapTilesKey;
	}
	return Value.TrimStartAndEnd();
}

FString FEarthWalkConfig::AccessCode()
{
	const FString Token = PlayerToken();
	return Token.IsEmpty() ? SharedCode() : Token;
}

bool FEarthWalkConfig::Home(double& OutLat, double& OutLon, FString& OutName)
{
	FString LatText, LonText;
	if (!Lookup(TEXT("HomeLat"), LatText) || !Lookup(TEXT("HomeLon"), LonText))
	{
		return false;
	}
	OutLat = FCString::Atod(*LatText);
	OutLon = FCString::Atod(*LonText);
	if (!Lookup(TEXT("HomeName"), OutName))
	{
		OutName = FString::Printf(TEXT("%.5f, %.5f"), OutLat, OutLon);
	}
	return FMath::Abs(OutLat) <= 85.0 && FMath::Abs(OutLon) <= 180.0;
}

void FEarthWalkConfig::StartLocation(double& OutLat, double& OutLon)
{
	const UEarthWalkSettings* Settings = GetDefault<UEarthWalkSettings>();
	OutLat = Settings->StartLatitude;
	OutLon = Settings->StartLongitude;

	// A signed-in player starts at home. The per-device memory below is kept for guests.
	double HomeLat = 0.0, HomeLon = 0.0;
	FString HomeName;
	if (IsSignedIn() && Home(HomeLat, HomeLon, HomeName))
	{
		OutLat = HomeLat;
		OutLon = HomeLon;
		return;
	}

	FString LatText, LonText;
	if (Lookup(TEXT("Lat"), LatText) && Lookup(TEXT("Lon"), LonText))
	{
		const double Lat = FCString::Atod(*LatText);
		const double Lon = FCString::Atod(*LonText);
		if (FMath::Abs(Lat) <= 85.0 && FMath::Abs(Lon) <= 180.0)
		{
			OutLat = Lat;
			OutLon = Lon;
		}
	}
}
