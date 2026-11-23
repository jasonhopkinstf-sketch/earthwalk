#pragma once

#include "CoreMinimal.h"
#include "EarthWorld.h"
#include "UObject/Object.h"
#include "EarthHome.generated.h"

class AEarthWalkHUD;
class FJsonObject;
class SEarthHomeView;
class UEarthWalkNet;

/**
 * A house of your own (docs/PROTOCOL.md, "A house of your own"; the Windows counterpart of houses.js
 * and decor.js in server/public/js). H is the home key: inside a house nobody lives in it makes the
 * house yours, inside your own (or just outside its door) it opens the furnishing panel, and anywhere
 * else it takes you home. A house somebody lives in has their name over its door, and is furnished
 * their way: its inside is fetched again whenever they change it.
 *
 * The panel swaps the walls, floors, sofa, beds and rugs for pieces that are owned or bought with
 * coins, puts prizes on show, and puts anything on show down where its owner stands. The server keeps
 * all of it and builds the rooms; this game only asks, and fetches the rooms again.
 *
 * The garden: up to four young animals before the front door, bought with coins, fed once a day from
 * the lunch box until they are grown, and giving something every day after that.
 *
 * A plan of one's own (docs/PROTOCOL.md, "A plan of one's own"): somebody signed in chooses a picture
 * of a real floor plan, the server reads it (POST /v1/plan), the panel shows the rooms that were read,
 * and a click has the inside of the house built from them. "/plan", "/plan build" and "/plan back" do
 * the same for those who type; -EWPlanFile=<file> names the picture without the box that asks for it.
 */
UCLASS()
class UEarthHome : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	/** Every frame, from the screen's own Tick. */
	void Frame(float DeltaSeconds);

	/** The H key: make this house mine, furnish my own, or go home. */
	void KeyHome();
	void Close();
	bool IsOpen() const { return bOpen; }
	/** "H: make this your house" and the like; empty when H would only take the player home. */
	const FString& GetHint() const { return Hint; }
	/** Within reach of my own kitchen: in my house, or by its door (the lunch box is a kitchen there). */
	bool AtHome() const { return bAtHome; }

	// What the buttons of the panel do.
	void Put(const FString& Slot, const FString& Id);
	void Show(const FString& Id, bool bOn);
	/** How: 0 puts it down a step in front of where I stand, 1 turns it a quarter round, 2 sends it back to a wall. */
	void Place(const FString& Id, int32 How);
	void MoveOut();
	/** A plan of one's own: asks for a picture of a floor plan and sends it to be read. */
	void ChoosePlan();
	/** Has the house built from the plan that was read; or goes back to the rooms the house came with. */
	void BuildPlan();
	void DropPlan();
	/** "/plan", "/plan build", "/plan back". */
	void PlanCommand(const FString& Word);
	/** The garden: "adopt" a young animal (Sp: chicken, sheep, pig or cow), or "feed", "gather" from or "release" the one at a place. */
	void Garden(const FString& Verb, const FString& Sp, int32 Index);

private:
	void Toggle();
	void Redraw();
	void GoHome();
	void UploadPlan(const FString& File);
	UEarthWalkNet* Room() const;
	/** The key of my own house ("x/y/id"), or empty when I have none. */
	FString MyKey() const;

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	TSharedPtr<SEarthHomeView> View;
	TSharedPtr<FJsonObject> Journal;
	FDelegateHandle JournalHandle;
	FDelegateHandle HouseHandle;
	FDelegateHandle LivedHandle;

	bool bOpen = false;
	bool bInside = false; // in a house I went into
	bool bInShop = false; // and it is a shop, a cafe or an office: nobody's to live in
	FEarthDoor Inside;
	FString InsideKey;
	bool bAtHome = false;
	bool bAtDoor = false; // just outside my own front door
	FString Hint;
	FString Had;        // my own house as last heard, so that moving in and out can be told
	bool bQuiet = true; // what a new connection says of my house is not news
	FString SureKey;    // moving house wants H twice
	double SureUntil = 0.0;
	double LeavingUntil = 0.0; // "Really move out?" wants a second click
	int32 Parting = -1;        // the animal "Send away" was clicked for once
	double PartingUntil = 0.0;
	double SinceScan = 0.0;
	bool bArriving = false; // sent home, and to be stood on the ground before the door once the world there has come
	int32 TagsLogged = -1;
	// A plan of one's own: a picture is being read, what went wrong last time, and the server's answer (plan, lines, notes, left).
	bool bReadingPlan = false;
	FString PlanError;
	TSharedPtr<FJsonObject> PlanRead;
	bool bShowPlan = false; // the panel is to be rolled to the part about a plan the next time it is drawn: there is news there
};
