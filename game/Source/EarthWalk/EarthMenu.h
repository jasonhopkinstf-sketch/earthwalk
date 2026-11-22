#pragma once

#include "CoreMinimal.h"
#include "Styling/SlateBrush.h"
#include "Styling/SlateTypes.h"
#include "Styling/SlateStyleMacros.h"
#include "Brushes/SlateRoundedBoxBrush.h"
#include "Widgets/SCompoundWidget.h"

class AEarthWalkHUD;
class SBorder;
class SEditableTextBox;
class STextBlock;
class SWidget;

/**
 * One thing a player can do, as the menu lists it. Everything the game can do is in one table
 * (EarthMenu.cpp), so that nothing has to be found out by typing "/help": the menu (Tab) shows all of
 * it, and the strip along the bottom the few used most.
 *
 * Most actions are a chat command under another name: `Command` is what would be typed after the
 * slash ("car away"). One that needs a place or a name has `Ask`, the question put in a small box, and
 * what is typed there is added to the command. A few (`ride`, `talk`...) are the game's own keys, and
 * AEarthWalkHUD::MenuAction knows them by `Id`.
 */
struct FEarthAction
{
	const TCHAR* Id;
	const TCHAR* Group;
	const TCHAR* Title;
	const TCHAR* About;   // a line on what it does
	const TCHAR* Key;     // the key that does it without the menu, or "" when only the menu does
	const TCHAR* Command; // "goto", "car away"... or "" for the game's own keys
	const TCHAR* Ask;     // "" when nothing more is needed
	const TCHAR* AskHint; // an example, shown faint in the empty box
	const TCHAR* Strip;   // its short name on the strip, or "" when it is not on it
};

namespace EarthMenu
{
	TConstArrayView<FEarthAction> Actions();
	const FEarthAction* Find(const FString& Id);
}

/**
 * The menu of everything a player can do, the small box that asks "where to?", and the strip of
 * buttons along the bottom. A widget of its own over the game, which lets the pointer through
 * everywhere but on its buttons.
 */
class SEarthMenu : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthMenu) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, AEarthWalkHUD* InOwner);

	void ShowMenu(bool bShow);
	/** Puts the question of an action up (null takes it away). */
	void ShowAsk(const FEarthAction* Action);
	void ShowStrip(bool bShow);
	TSharedPtr<SEditableTextBox> GetAskInput() const { return AskInput; }

private:
	TSharedRef<SWidget> ActionButton(const FEarthAction& Action, bool bOnStrip);
	void HandleAsked(const FText& Text, ETextCommit::Type How);

	TWeakObjectPtr<AEarthWalkHUD> Owner;
	TSharedPtr<SBorder> MenuPanel;
	TSharedPtr<SBorder> AskPanel;
	TSharedPtr<STextBlock> AskTitle;
	TSharedPtr<SEditableTextBox> AskInput;
	TSharedPtr<SWidget> Strip;

	FSlateRoundedBoxBrush PanelBrush = FSlateRoundedBoxBrush(FLinearColor::White, 12.f);
	FSlateRoundedBoxBrush KeyBrush = FSlateRoundedBoxBrush(FLinearColor(FColor(245, 197, 24)), 5.f);
	// A line of the menu: it lights up under the pointer.
	FButtonStyle RowButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 16)), 8.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f));
	// A button of the strip: dark, so that it reads over grass and sky alike.
	FButtonStyle StripButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(18, 24, 34, 205)), 9.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(52, 104, 190, 235)), 9.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 255)), 9.f));
};
