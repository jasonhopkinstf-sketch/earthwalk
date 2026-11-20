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

	/** Turn on if the world renders inside-out (you can see through the ground from above). */
	UPROPERTY(Config, EditAnywhere, Category = "World")
	bool bFlipTriangleWinding = false;

	UPROPERTY(Config, EditAnywhere, Category = "Player")
	bool bInvertMouseY = false;

	/** Multiplier for mouse look speed. */
	UPROPERTY(Config, EditAnywhere, Category = "Player", meta = (ClampMin = 0.05, ClampMax = 20.0))
	float MouseSensitivity = 1.f;
};

/**
 * Per-player values. Each is resolved in this order:
 *   1. command line (-EWServer= -EWName= -EWAvatar= -EWRoom= -EWCode= -EWLat= -EWLon=)
 *   2. what the player last set with a chat command (saved in GameUserSettings.ini)
 *   3. the project defaults above
 */
struct FEarthWalkConfig
{
	static FString ServerUrl();
	static FString PlayerName();
	static FString Room();
	static FString Avatar();
	static FString AccessCode();
	static void StartLocation(double& OutLat, double& OutLon);

	/** Saves a per-player override. Keys: Server, Name, Avatar, Room, Code, Lat, Lon. */
	static void Save(const TCHAR* Key, const FString& Value);

private:
	static bool Lookup(const TCHAR* Key, FString& Out);
};
