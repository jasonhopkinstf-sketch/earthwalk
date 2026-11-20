#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
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

private:
	void OpenChat();
	void RunCommand(const FString& Command, const FString& Argument);
	void GoToPlace(const FString& Query);
	void GoToPerson(const FString& Name);
	FString StatusText() const;

	TSharedPtr<SEarthWalkOverlay> Overlay;
	FDelegateHandle ChatHandle;
	FDelegateHandle NoticeHandle;
	bool bChatOpen = false;
	double ChatClosedAt = 0.0;
	float StatusTimer = 0.f;
};
