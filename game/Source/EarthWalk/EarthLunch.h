#pragma once

#include "CoreMinimal.h"
#include "EarthWalkNet.h"
#include "UObject/Object.h"
#include "EarthLunch.generated.h"

class AEarthWalkHUD;
class FJsonObject;
class SEarthLunchView;

/**
 * Food and hearts (docs/PROTOCOL.md, "Food and hearts"; the Windows counterpart of
 * server/public/js/lunch.js). Five hearts in the corner, one for each kind of good food, filled by
 * eating; the lunch box (the B key) with what is carried and a button to eat each thing, or to give it
 * to a friend standing by; and, beside a real shop or café on the map, what it sells.
 *
 * The server keeps all of it. The journal says what is in the lunch box and which hearts are full,
 * `menu` what is sold here, and `pep` whether all five hearts are full, which makes the player a
 * little quicker on their feet for the rest of the day. Food comes from the world: a cow or a hen that
 * is talked to gives some, and so does a fruit tree.
 *
 * In a house of one's own the lunch box is a kitchen too: recipes turn what is carried into meals, two helpings at a time.
 */
UCLASS()
class UEarthLunch : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	/** Every frame, from the screen's own Tick: is there a shop within reach, or a friend to give something to? */
	void Frame(float DeltaSeconds);

	/** The B key: the lunch box, open or shut. */
	void Toggle();
	void Close();
	bool IsOpen() const { return bOpen; }
	/** "B: buy food at ..." while a shop is within reach; empty the rest of the time. */
	const FString& GetHint() const { return Hint; }
	/** Says whether the player is in their own kitchen (a house of their own, or by its door), where recipes can be cooked. */
	void SetKitchen(TFunction<bool()> InAtHome) { AtHome = MoveTemp(InAtHome); }

	// What the buttons of the lunch box do.
	void Eat(const FString& Id);
	void Buy(const FString& Id);
	void Give(const FString& Id);
	void Cook(const FString& Id);

private:
	void Redraw();
	void DrawHearts();
	void AskMenu();
	class UEarthWalkNet* Room() const;

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TSharedPtr<SEarthLunchView> View;
	TSharedPtr<FJsonObject> Journal;
	FDelegateHandle JournalHandle;
	FDelegateHandle MenuHandle;
	FDelegateHandle PepHandle;
	FDelegateHandle StampHandle;
	FDelegateHandle WelcomeHandle;

	bool bOpen = false;
	bool bShop = false; // a shop or a café within reach
	FString ShopText;
	FString ShopUse;
	bool bMenu = false; // what it sells has come
	FEarthMenu Menu;
	FString FriendId; // the friend near enough to be given something
	FString FriendName;
	FString Hint;
	double SinceScan = 0.0;
	double AskJournalAt = 0.0; // when to ask for the journal (a moment after the welcome); 0 for not waiting
	TFunction<bool()> AtHome;
	bool bHome = false; // in my own kitchen, as last looked
};
