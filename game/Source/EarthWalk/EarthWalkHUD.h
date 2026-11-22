#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "Templates/Function.h"
#include "EarthWalkHUD.generated.h"

class SEarthMenu;
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
	void LookUpPlace(const FString& Query, TFunction<void(const FString& Name, double Lat, double Lon)> Found);
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

private:

	void OpenMenu();
	void CloseMenu();
	void OpenAsk(const FString& Id);
	/** H: the strip of buttons along the bottom, on or off, and remembered. */
	void ToggleStrip();
	/** Typing into the chat box or into the box that asks "where to?": the keys are letters, not commands. */
	bool Typing() const { return bChatOpen || bAskOpen; }

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
	FString TalkingToShown;
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
