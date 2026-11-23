#pragma once

#include "CoreMinimal.h"
#include "EarthWalkNet.h"
#include "UObject/Object.h"
#include "EarthCare.generated.h"

class AEarthWalkHUD;
class FJsonObject;
class SEarthCareView;

/**
 * Games with animals (the Windows counterparts of carebubbles.js and train.js in server/public/js):
 *
 * - Hungry animals. On any day about one animal in five is hungry for one food (docs/PROTOCOL.md,
 *   "Hungry animals"; the rule of server/public/js/care.js, kept in step here). A thought bubble
 *   hangs over each hungry one nearby saying what it would like; talking to it (T) with that food in
 *   the lunch box feeds it. The journal says which have been fed today.
 * - Tricks (K). The panel lists the tricks there are: those the companion at the player's side
 *   knows, each with a button to have it do one, and the next it could learn. A lesson is a small
 *   game of timing: paw prints run along a bar towards a ring, and Space is pressed as each one
 *   reaches it. The server sets the beats and marks the presses; one slip is forgiven.
 * - The agility course: set up from the tricks panel; the companion leaps as its runner comes to a
 *   jump (the obstacles themselves are AEarthRaceCourse's).
 */
UCLASS()
class UEarthCare : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	void Frame(float DeltaSeconds);

	/** The K key: the tricks panel, open or shut. */
	void Toggle();
	void Close();
	bool IsOpen() const { return bOpen; }
	/** A lesson is under way: the player stands still and Space is for the lesson. */
	bool InLesson() const { return bLesson; }
	/** "It is hungry for an apple: T to talk" beside a hungry animal; empty the rest of the time. */
	const FString& GetHint() const { return Hint; }

	// What the buttons of the panel do, and the typed commands.
	void Teach();
	/** Has the companion do a trick it knows, by its id or its name ("sit", "Sit up"); false when it knows no such trick. */
	bool Perform(const FString& Which);
	void Agility();

	/** The food an animal is hungry for on a day, or nothing when it is not hungry: hungerOf of care.js. */
	static FString HungerOf(const FString& Sp, uint32 Thing, int64 Day);

private:
	void Redraw();
	void Begin(const FEarthLesson& Set);
	void Marked(const FEarthLesson& Result);
	void Press();
	class UEarthWalkNet* Room() const;
	void Say(const FString& Text) const;
	void HoldStill(bool bHold) const;

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TSharedPtr<SEarthCareView> View;
	TSharedPtr<FJsonObject> Journal;
	FDelegateHandle JournalHandle;
	FDelegateHandle LessonHandle;
	FDelegateHandle StampHandle;

	bool bOpen = false;
	FString Hint;
	TSet<FString> Fed; // "horse:918398760": fed by me today
	double SinceScan = 0.0;

	// The lesson under way.
	bool bLesson = false;
	FString LessonName;
	TArray<double> Beats;
	double Slack = 0.0;
	double LessonStart = 0.0; // FPlatformTime seconds
	TArray<int32> Presses;
	bool bHandedIn = false;
	double BarUntil = 0.0; // the bar stays up this long after the presses are handed in, at the latest
};
