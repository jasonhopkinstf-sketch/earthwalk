#pragma once

#include "CoreMinimal.h"
#include "Styling/SlateBrush.h"
#include "UObject/Object.h"
#include "EarthMiniMap.generated.h"

class AEarthWalkHUD;
class SWidget;
class USceneCaptureComponent2D;
class UTextureRenderTarget2D;

/** Something marked on the little map: where it is, in metres east and south of the world's origin. */
struct FEarthMapMark
{
	enum class EKind : uint8
	{
		Friend,  // somebody else in the room
		Door,    // a front door that opens
		Station, // where a train stops
		Parked,  // a parked car nobody has driven off
		MyCar,   // the player's own car, standing somewhere
		Taxi,    // the taxi the player called
		Goal,    // where the player is being taken
		Gate,    // a gate of the race still to pass
	};
	EKind Kind = EKind::Door;
	double X = 0.0;
	double Z = 0.0;
	FString Label;
	bool bPoint = false; // off the map, it is still pointed to from the edge (the nearest station is)
};

/** What the map's widget draws: worked out by UEarthMiniMap each frame, read by the widget when it paints. */
struct FEarthMapView
{
	int32 Size = 1; // 0 hidden, 1 small, 2 large
	bool bPicture = false;
	FSlateBrush Picture;      // the world from above, north at the top
	double CentreX = 0.0;     // where the middle of the picture is, metres east of the origin
	double CentreZ = 0.0;     // and south
	double PictureSpan = 1.0; // how many metres the picture is across
	double Span = 1.0;        // how many of them are shown: the picture is a little larger, so the map can slide between pictures
	double MeX = 0.0;
	double MeZ = 0.0;
	double MeYaw = 0.0; // the way the player looks, compass degrees
	TArray<FEarthMapMark> Marks;
	TArray<FVector2D> Way; // the road to where the player is being taken, from where they are
	FString Going;         // the name of that place; empty when going nowhere
	double GoingFar = -1.0; // how far it is, when that is not the distance on the map (a flight across the world); below 0, measured on the map
};

/**
 * The little map in the top right corner: the world round the player seen from straight above, north
 * at the top and the player in the middle, with what helps in getting about marked on it. Friends,
 * doors that open, where trains stop, parked cars, the player's own car, the taxi they called, and the
 * road to wherever they are being taken.
 *
 * The picture is the game's own world drawn a second time, small, by a camera a kilometre up that
 * looks straight down and takes a picture three times a second (not every frame). It takes the bare
 * colours of things, with no light, shadow or ink line: that is both the cheapest picture there is and
 * the one that reads most like a map. Between pictures the map slides under the player, so it moves
 * smoothly whatever the camera's pace.
 *
 * M makes it large, then hides it, then brings it back; which is remembered (Map in the settings,
 * -EWMap=small|big|off for one run). -EWMapCost measures what it costs: see Frame.
 */
UCLASS()
class UEarthMiniMap : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	/** Every frame, from the screen's own Tick. */
	void Frame(float DeltaSeconds);
	/** M: small, large, hidden, and round again. Returns a line that says which, for the chat window. */
	FString Cycle();

private:
	void SetSize(int32 NewSize);
	void TakePicture(const FVector& Here);
	void FindStill();
	void CostTest(float DeltaSeconds);

	UPROPERTY()
	TObjectPtr<USceneCaptureComponent2D> Camera;

	UPROPERTY()
	TObjectPtr<UTextureRenderTarget2D> Target;

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TSharedPtr<FEarthMapView> View;
	TSharedPtr<SWidget> Widget;
	double PictureAt = 0.0;
	double StillAt = 0.0;
	TArray<FEarthMapMark> Still; // doors, stations and parked cars: looked for once a second, not every frame

	// -EWMapCost: the frame time with the map hidden, small and large, turn and turn about.
	bool bCost = false;
	double CostStart = 0.0;
	int32 CostPhase = -1;
	double CostSum[3] = { 0.0, 0.0, 0.0 };
	int32 CostFrames[3] = { 0, 0, 0 };
	int32 SizeBeforeCost = 1;
};
