#pragma once

#include "CoreMinimal.h"
#include "Engine/DeveloperSettings.h"
#include "EarthWalkSettings.generated.h"

/** Project defaults (Project Settings > Game > EarthWalk, stored in Config/DefaultGame.ini). */
UCLASS(Config = Game, DefaultConfig, meta = (DisplayName = "EarthWalk"))
class UEarthWalkSettings : public UDeveloperSettings
{
	GENERATED_BODY()

public:
	/** Address of the EarthWalk world server, e.g. https://world.example.com */
	UPROPERTY(Config, EditAnywhere, Category = "Server")
	FString ServerUrl = TEXT("http://localhost:8787");

	/** Shared access code, if the server was started with one. */
	UPROPERTY(Config, EditAnywhere, Category = "Server")
	FString AccessCode;

	UPROPERTY(Config, EditAnywhere, Category = "Player")
	FString PlayerName = TEXT("Guest");

	/** Which animal the player appears as: fox, bear, rabbit, cat, owl or frog. */
	UPROPERTY(Config, EditAnywhere, Category = "Player")
	FString Avatar = TEXT("fox");

	/** People in the same room see each other and share a chat. */
	UPROPERTY(Config, EditAnywhere, Category = "Player")
	FString Room = TEXT("family");

	UPROPERTY(Config, EditAnywhere, Category = "World")
	double StartLatitude = 48.8583;

	UPROPERTY(Config, EditAnywhere, Category = "World")
	double StartLongitude = 2.2945;

	/** How many chunks (each roughly 400-600 m) to keep loaded in every direction. */
	UPROPERTY(Config, EditAnywhere, Category = "World", meta = (ClampMin = 1, ClampMax = 6))
	int32 ViewRadiusChunks = 2;

	/** How many chunks around the player get trees, letterboxes and street signs (0 turns them off). */
	UPROPERTY(Config, EditAnywhere, Category = "World", meta = (ClampMin = 0, ClampMax = 6))
	int32 LabelRadiusChunks = 2;

	/** Turn on if the world renders inside-out (you can see through the ground from above). */
	UPROPERTY(Config, EditAnywhere, Category = "World")
	bool bFlipTriangleWinding = false;

	/**
	 * Google Map Tiles API key for the photographic world (/world photo). Leave empty to keep it off.
	 * A key written here is shipped with the game; a key typed with /mapskey stays on this PC only.
	 */
	UPROPERTY(Config, EditAnywhere, Category = "World")
	FString GoogleMapTilesKey;

	/**
	 * /world auto: flying higher than this over the ground (in metres) shows Google's photographic
	 * tiles instead of the generated world, which comes back below PhotoBelowMeters. The gap between
	 * the two stops the view flickering at the boundary.
	 */
	UPROPERTY(Config, EditAnywhere, Category = "World", meta = (ClampMin = 20.0))
	double PhotoAboveMeters = 60.0;

	UPROPERTY(Config, EditAnywhere, Category = "World", meta = (ClampMin = 10.0))
	double PhotoBelowMeters = 45.0;

	/**
	 * The drawn look: light sorted into flat levels and ink outlines over the whole picture
	 * (M_EarthInk). Off shows the same painted world lit plainly.
	 */
	UPROPERTY(Config, EditAnywhere, Category = "Look")
	bool bInkOutlines = true;

	/**
	 * Other values for M_EarthInk's settings, by name (InkWidth, InkStrength, Band1, Level0 and so
	 * on; the list is in EarthWalkAssetsCommandlet.cpp), for trying a look without rebuilding the art.
	 * -EWInk=Name:value,Name:value on the command line does the same for one run.
	 */
	UPROPERTY(Config, EditAnywhere, Category = "Look")
	TMap<FString, float> InkTuning;

	UPROPERTY(Config, EditAnywhere, Category = "Player")
	bool bInvertMouseY = false;

	/** Multiplier for mouse look speed. */
	UPROPERTY(Config, EditAnywhere, Category = "Player", meta = (ClampMin = 0.05, ClampMax = 20.0))
	float MouseSensitivity = 1.f;
};

/**
 * Per-player values. Each is resolved in this order:
 *   1. command line (-EWServer= -EWName= -EWAvatar= -EWRoom= -EWCode= -EWToken= -EWLat= -EWLon= -EWMapsKey=)
 *   2. what the player last set with a chat command (saved in GameUserSettings.ini)
 *   3. the project defaults above
 */
struct FEarthWalkConfig
{
	static FString ServerUrl();
	static FString PlayerName();
	static FString Room();
	static FString Avatar();
	/**
	 * What the server accepts as the Bearer credential: the signed-in player's token when
	 * there is one (/login), otherwise the shared access code (/code).
	 */
	static FString AccessCode();
	/** The shared access code alone, even when signed in (the sign-in link carries it). */
	static FString SharedCode();
	/** The signed-in player's token, or empty when playing as a guest. */
	static FString PlayerToken();
	/** The Google Map Tiles API key for the photographic world, or empty when there is none. */
	static FString MapsKey();
	static bool IsSignedIn() { return !PlayerToken().IsEmpty(); }
	/** The account home saved from the last welcome, if any. */
	static bool Home(double& OutLat, double& OutLon, FString& OutName);
	/** Where to appear: the signed-in account's home, else where this device left off, else the project default. */
	static void StartLocation(double& OutLat, double& OutLon);

	/**
	 * Saves a per-player override. Keys: Server, Name, Avatar, Room, Code, Token, HomeLat, HomeLon,
	 * HomeName, Lat, Lon, MapsKey. An empty value clears the override.
	 */
	static void Save(const TCHAR* Key, const FString& Value);
	/** True when the player set this value (command line or chat command) rather than using the project default. */
	static bool HasOverride(const TCHAR* Key, FString& Out) { return Lookup(Key, Out); }

private:
	static bool Lookup(const TCHAR* Key, FString& Out);
};
