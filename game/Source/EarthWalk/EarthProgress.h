#pragma once

#include "CoreMinimal.h"
#include "EarthWalkNet.h"
#include "UObject/Object.h"
#include "EarthProgress.generated.h"

class AEarthWalkHUD;
class SEarthProgressView;

/**
 * The progress bar (docs/PROTOCOL.md, "Progress"; the Windows counterpart of server/public/js/progress.js).
 * Under the five hearts, so that health and progress are read together: a round gold badge with the
 * level's number, the level's name, a thin bar of how far along it is, and a line that says what would
 * reach the next ("Two new places to level 4"). A click opens the passport.
 *
 * The server says where the player stands once after the welcome, and then every time points are earned,
 * with a few words for what earned them: the bar moves, turns gold for the moment, and a cream note under
 * it says "+3  fed a hungry cow". A new level fills the bar to the brim first, starts it again on the new
 * level, throws coloured paper from the badge and says what the level gave. News is shown one piece at a
 * time, in the order it came.
 *
 * -EWProgressShow=gain|level shows a made-up piece of news eight seconds in, for pictures.
 */
UCLASS()
class UEarthProgress : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	/** Every frame, from the screen's own Tick. */
	void Frame(float DeltaSeconds);
	/** What would reach the next level, as the server words it; empty until it has said. */
	const FString& GetHint() const { return Shown.Hint; }

	// What the widget draws, read when it paints.
	bool IsKnown() const { return bKnown; }
	const FEarthLevel& GetLevel() const { return Shown; }
	float GetFill() const { return static_cast<float>(Fill); }
	/** Points have just come in: the bar is gold for the moment. */
	bool IsLit() const { return bBusy && Age < 1.2; }
	/** A new level is being celebrated. */
	bool IsUp() const { return bBusy && Now.bUp && bFlipped; }
	/** The note under the bar: its large line (a new level only), the points in bold, and the words. All empty when there is none. */
	const FString& GetNoteBig() const { return NoteBig; }
	const FString& GetNotePlus() const { return NotePlus; }
	const FString& GetNoteWords() const { return NoteWords; }
	/** Seconds since the coloured paper was thrown; below 0 when there is none in the air. */
	double GetPaperAge() const { return PaperAge; }
	/** The bar was clicked. */
	void Clicked();

private:
	void Take(const FEarthProgress& News);
	void Start(const FEarthProgress& News);
	class UEarthWalkNet* Room() const;

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TSharedPtr<SEarthProgressView> View;
	FDelegateHandle ProgressHandle;
	FDelegateHandle JournalHandle;

	bool bKnown = false;
	FEarthLevel Shown; // the level the bar is showing
	double Fill = 0.0;  // how full the bar is drawn, 0 to 1
	double Target = 0.0;
	TArray<FEarthProgress> Waiting; // news not shown yet
	bool bBusy = false;
	FEarthProgress Now; // the piece of news being shown
	double Age = 0.0;
	bool bFlipped = false; // a new level: the bar has been to the brim and started again
	FString NoteBig;
	FString NotePlus;
	FString NoteWords;
	double PaperAge = -1.0;
	double Clock = 0.0;
	bool bTestShown = false;
};
