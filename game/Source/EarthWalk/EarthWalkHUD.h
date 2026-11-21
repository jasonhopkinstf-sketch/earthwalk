#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "Templates/Function.h"
#include "EarthWalkHUD.generated.h"

class SEarthWalkOverlay;

/**
 * On-screen overlay: a status line, the chat log and the chat/command box.
 *
 * Anything typed that starts with "/" is a command (see /help); everything else is chat.
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

	TSharedPtr<SEarthWalkOverlay> Overlay;
	FDelegateHandle ChatHandle;
	FDelegateHandle NoticeHandle;
	FDelegateHandle WelcomeHandle;
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
