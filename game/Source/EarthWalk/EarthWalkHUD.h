#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "Templates/Function.h"
#include "EarthWalkHUD.generated.h"

class SEarthMenu;
class UEarthMiniMap;
class UEarthLunch;
class UEarthFlight;
class UEarthHome;
class UEarthCare;
class SEarthWalkOverlay;
class UEarthCompany;

/**
 * On-screen overlay: a status line, the chat log and the chat/command box, the header that names the
 * place, what E and T would do just now, the speech bubbles of things that have spoken, the
 * passport (P) and the list of things to show somebody (G). Over it, the menu of everything a
 * player can do (Tab), with its strip of buttons (EarthMenu.h).
 *
 * Anything typed that starts with "/" is a command (see /help); everything else is chat. Nothing
 * needs a command, though: the menu does all of it.
 */
UCLASS()
class AEarthWalkHUD : public AHUD
{
	GENERATED_BODY()

public:
	virtual void BeginPlay() override;
	virtual void EndPlay(const EEndPlayReason::Type EndPlayReason) override;
	virtual void Tick(float DeltaSeconds) override;

	/** Called by the overlay when the player presses Enter in the chat box. */
	void Submit(const FString& Text);
	void CloseChat();
	void AddLine(const FString& Text, const FLinearColor& Color = FLinearColor::White);

	/** Pointer free and visible; the mouse looks around only while a button is held. */
	static void ApplyGameInputMode(APlayerController* PC);

private:
	void OpenChat();
	void RunCommand(const FString& Command, const FString& Argument);
	void GoToPlace(const FString& Query);
	void GoToPerson(const FString& Name);
	/** Asks the server where a place is; `Found` runs only on success, failures are reported in the log. */
	void LookUpPlace(const FString& Query, TFunction<void(const FString& Name, double Lat, double Lon)> Found, bool bFromHere = false);
	void ShowPeople();
	FString StatusText() const;
	/** The header that names the place the player is in: asks the server when they have moved to another square about a kilometre across. */
	void UpdateWhere();
	void LookUpWhere(const FString& Key, double Lat, double Lon);
	/** Riding, talking and telling things what to do; null until the world has made it. */
	UEarthCompany* Company() const;
	/** E, T, P and Esc, the line that says what E and T would do, and the speech bubbles. */
	void UpdateCompany(APlayerController* PC);
	/** The passport: the player's own journal, as the server keeps it. P opens and closes it. */
	void TogglePassport();
	void ClosePassport();
	/** "Show me...": the list of things to show somebody. G opens and closes it. */
	void ToggleShows();
	void CloseShows();
	/** Makes the player another animal (/animal bear, or the six in the passport): saved, and told to the room. */
	void BecomeAnimal(const FString& Animal);

public:
	/** One of the things to show was picked, with the mouse or by its number: the list goes away and the player is taken there. */
	void ShowChosen(const FString& Id);
	/** A button in the passport was pressed: buy or wear a hat, start or give up a hunt or an expedition, drop a favour. */
	void PassportAction(const FString& What, const FString& Id);
	/** Something in the menu or on the strip was chosen (EarthMenu.h): does it, or asks what it needs to know first. */
	void MenuAction(const FString& Id);
	/** Tab: the menu of everything there is to do, up or away. */
	void ToggleMenu();
	/** The box that asked "where to?" has its answer; nothing typed is a change of mind. */
	void AskDone(const FString& Typed);
	/** Says something to the thing being talked to: typed on the bubble's line, or one of its buttons. */
	void TalkSay(const FString& Text);
	/** Puts the "What's new" card away: its button, or Esc. */
	void CloseNews();
	/** Esc on the bubble's line: the conversation is over. */
	void EndTalk() { CloseTalk(true); }
	/** The choice once a place is found was made: 0 go there now, 1 be flown there and watch; anything else is a change of mind. */
	void ChoiceDone(int32 Which);
	/** Asks the guide something in plain words (Q, the menu, "/guide ..."): the answer comes in the bubble at the foot of the screen. */
	void GuideAsk(const FString& Question);
	/** One of the buttons under the guide's answer that start the trip: take me there, call a taxi, go there now, show me. */
	void GuideGo(int32 Index);

private:

	void OpenMenu();
	void CloseMenu();
	void OpenAsk(const FString& Id);
	/** Z: the strip of buttons along the bottom, on or off, and remembered. */
	void ToggleStrip();
	/** Typing into the chat box or into the box that asks "where to?": the keys are letters, not commands. */
	bool Typing() const { return bChatOpen || bAskOpen || bTalkOpen || bChoiceOpen; }
	/** "Go to a place..." from the menu: finds it, and offers to go at once or to be flown there (EarthFlight.h). */
	void GoChoose(const FString& Query);
	/** Looks a place up and flies there at once: "/flyto ...". */
	void FlyToPlace(const FString& Query);
	bool bChoiceOpen = false;
	FString ChoiceName;
	double ChoiceLat = 0.0;
	double ChoiceLon = 0.0;
	/** The conversation with a thing, in its bubble at the foot of the screen (EarthMenu.h): T starts one. */
	void OpenTalk();
	void CloseTalk(bool bStopTalking);
	bool bTalkOpen = false;
	FString TalkNameShown;
	// The guide has the bubble (bTalkOpen is true as well): the question now up, and what its answer's buttons do.
	void OnGuideAnswer(const struct FEarthGuideAnswer& Answer);
	bool bGuideOpen = false;
	bool bGuideWaiting = false;
	FString GuideQuestion;
	FString GuidePlace;
	double GuideLat = 0.0;
	double GuideLon = 0.0;
	TArray<FString> GuideActs;  // for each button shown: "take", "taxi", "jump" or "show"
	TArray<FString> GuideShows; // and for "show", which Show me place
	FDelegateHandle GuideHandle;
	FDelegateHandle ErrorHandle;

	/** The little map in the top right corner (EarthMiniMap.h). M makes it large, hides it, and brings it back. */
	UPROPERTY()
	TObjectPtr<UEarthMiniMap> MiniMap;
	void CycleMap();
	/** Food and hearts: the five hearts in the corner and the lunch box (EarthLunch.h). B opens and closes it. */
	UPROPERTY()
	TObjectPtr<UEarthLunch> Lunch;
	/** Being flown to a place and watching (EarthFlight.h). */
	UPROPERTY()
	TObjectPtr<UEarthFlight> Flight;
	/** A house of your own: the names over doors and the furnishing panel (EarthHome.h). H is the home key. */
	UPROPERTY()
	TObjectPtr<UEarthHome> House;
	/** Games with animals: thoughts over hungry ones, the tricks panel and its lessons (EarthCare.h). K is the tricks key. */
	UPROPERTY()
	TObjectPtr<UEarthCare> Care;
	/** -EWRun's commands still to run, one after another, and when the next may (a "wait_3" among them holds the rest up). */
	TArray<FString> RunQueue;
	double RunNextAt = 0.0;

	/**
	 * "What's new": asks the server what has been added since the version this player last saw the
	 * notes of, and shows it on a card. bOnlyNew is the look on arriving, which shows nothing when
	 * nothing is new; otherwise (from the menu) the newest few are shown whatever was seen.
	 */
	void OpenNews(bool bOnlyNew);
	bool bNewsOpen = false;
	bool bNewsChecked = false;

	TSharedPtr<SEarthMenu> Menu;
	bool bMenuOpen = false;
	bool bAskOpen = false;
	bool bStripOn = true;
	bool bMenuTookEsc = false; // Esc has just put the menu away, and is not also "leave the game?"
	bool bMenuTested = false;
	double AskOpenedAt = 0.0;
	FString AskAction;
	TSharedPtr<SEarthWalkOverlay> Overlay;
	FDelegateHandle ChatHandle;
	FDelegateHandle NoticeHandle;
	FDelegateHandle WelcomeHandle;
	FDelegateHandle JournalHandle;
	FDelegateHandle StampHandle;
	bool bCompanyBound = false;
	bool bPassportOpen = false;
	bool bPassportTested = false;
	bool bShowsOpen = false;
	bool bShowsTested = false;
	bool bRunTested = false;
	double QuitAskedAt = -100.0; // when Esc last asked "leave?"; Esc again within a few seconds leaves
	bool bCluePending = false; // /clue asked for the journal, to read the clue out when it comes
	double StartedAt = 0.0;
	bool bChatOpen = false;
	double ChatClosedAt = 0.0;
	float StatusTimer = 0.f;

	// The header: the square being asked about ("52.03,4.78"), what the server called it, and when to ask.
	FString WhereKey;
	FString WhereName;
	FString WhereCountry;
	double WhereAskAt = 0.0; // 0: nothing waiting to be asked
	double WhereLat = 0.0;
	double WhereLon = 0.0;
};
