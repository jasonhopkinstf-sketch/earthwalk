#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "EarthWorldMap.generated.h"

class AEarthWalkHUD;
class SEarthWorldMapView;
class UTexture2D;
struct FSlateBrush;

/** The sums of the world map: mapview.js of server/public/js over again. Keep the two in step. */
namespace EarthMapSums
{
	constexpr double TilePx = 256.0;
	constexpr double MinZoom = 2.0, MaxZoom = 18.5, StartZoom = 15.0;
	constexpr int32 MaxTileZoom = 17;

	/** A place on Earth as a point of the whole world's map at a zoom, in pixels (x east from the date line, y south). */
	FVector2D PointOf(double Lat, double Lon, double Zoom);
	/** The place on Earth at a point of the whole world's map at a zoom: X is the latitude and Y the longitude. */
	FVector2D GeoOf(double X, double Y, double Zoom);
	struct FTile
	{
		int32 Z = 0, X = 0, Y = 0;
		double Left = 0.0, Top = 0.0, Size = 256.0; // where it is drawn, on the world's map at the zoom asked for
	};
	/** The pictures that cover a screen W by H whose middle is the point Mid of the world's map at Zoom. */
	void TilesFor(const FVector2D& Mid, double Zoom, double W, double H, TArray<FTile>& Out);
	/** "2.4 km to the north-east of you". */
	FString AwayWords(double FromLat, double FromLon, double ToLat, double ToLon);
}

/**
 * The world map: a street map of the whole Earth to look round on, and to choose a place from
 * (server/public/js/worldmap.js is the browser's). N opens it and puts it away. Drag it to move it, turn
 * the wheel to come closer or stand back, and click where you want to go: it names the place and offers
 * a taxi there, a flight there, or going there at once.
 *
 * The game draws only the world near the player, so the map is made of pictures: squares of
 * OpenStreetMap's own map, asked of the game's server (GET /v1/maptile, server/src/maptiles.ts) and never
 * of OpenStreetMap itself, so that nobody outside learns who looked at what. Their credit is on the map,
 * as they ask. The player, their friends and the place chosen are drawn over the pictures.
 */
UCLASS()
class UEarthWorldMap : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	void Toggle();
	void Close();
	bool IsOpen() const { return bOpen; }

	// ---- for the view that draws it and takes the mouse
	struct FMark
	{
		double Lat = 0.0, Lon = 0.0;
		FString Name;
		double Heading = 0.0; // degrees clockwise from north, for the player's own mark
	};
	double GetZoom() const { return Zoom; }
	FVector2D GetCentre() const { return FVector2D(CentreLat, CentreLon); }
	/** The brush of one picture of the map, asked for when it is not here yet: null until it has come. */
	const FSlateBrush* PictureOf(int32 Z, int32 X, int32 Y);
	bool Me(FMark& Out) const;
	void Friends(TArray<FMark>& Out) const;
	bool HasPick() const { return bPick; }
	FVector2D GetPick() const { return FVector2D(PickLat, PickLon); }
	/** The map was dragged by so many pixels, or the wheel was turned with the pointer so far from the middle of it. */
	void DragBy(const FVector2D& From, const FVector2D& Pixels);
	void ZoomBy(double By, const FVector2D& About);
	/** A place was clicked: so far from the middle of the map, in pixels. */
	void Choose(const FVector2D& FromMiddle);
	void ClearPick();
	/** Back to where the player is, close enough to see the streets. */
	void Home();
	/** Brighter colours, or the map as it comes. */
	void SwitchLook();
	/** What a button of the card does: 0 a taxi there, 1 a flight there, 2 there at once. */
	void Go(int32 How);
	/** For tests: works the mouse over the map ("wheel", "drag" or "click"), through the engine's own handling of it. */
	void TestMouse(const FString& What);

private:
	void Ask(int32 Z, int32 X, int32 Y, const FString& Key);
	void Pump();
	void ShowCard();

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TSharedPtr<SEarthWorldMapView> View;
	bool bOpen = false;
	double CentreLat = 0.0, CentreLon = 0.0;
	double Zoom = 15.0;
	bool bBright = true;
	bool bPick = false;
	double PickLat = 0.0, PickLon = 0.0;
	FString PickName;   // empty until it has been looked up
	bool bPickNamed = false;
	FString PickAway;
	int32 PickSerial = 0;

	/** The pictures held: the textures (kept alive here), their brushes, and when each was last looked at. */
	UPROPERTY()
	TMap<FString, TObjectPtr<UTexture2D>> Pictures;
	TMap<FString, TSharedPtr<FSlateBrush>> Brushes;
	TMap<FString, double> Used;
	TSet<FString> Asked;      // asked for, not here yet
	TMap<FString, double> None; // could not be had: not asked for again until this time
	struct FWant { int32 Z, X, Y; FString Key; };
	TArray<FWant> Queue;
	int32 Asking = 0;
	int32 LookSerial = 0;
};
