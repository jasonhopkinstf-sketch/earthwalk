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

/** One release on the "What's new" card: what it was about, and what came with it, a line each. */
struct FEarthNewsEntry
{
	FString Version;
	FString Title;
	/** What is new, and beside it "" or a few words on where it is ("In the browser game so far"). */
	TArray<TPair<FString, FString>> Items;
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
	void ShowAsk(const FEarthAction* Action, const TArray<FString>& Choices = TArray<FString>());
	void ShowStrip(bool bShow);
	/**
	 * The choice once a place is found: there at once (Enter), or flown there to watch (F). Title is the
	 * place, Sub how far it is, FlyAbout what the flight will be like.
	 */
	void ShowChoice(bool bShow, const FString& Title = FString(), const FString& Sub = FString(), const FString& FlyAbout = FString());
	TSharedPtr<SEditableTextBox> GetAskInput() const { return AskInput; }

	/**
	 * The conversation with a thing: a speech bubble at the foot of the screen with its name, what it
	 * last said, a few things to say with one click, and a line to type on. `Replies` are those few
	 * things, as what the button says and what is said ("Follow me" / "follow me"); one whose words
	 * are "..." asks where to first ("Take me to...").
	 */
	void ShowTalk(bool bShow, const FString& Name = FString(), const TArray<TPair<FString, FString>>& Replies = TArray<TPair<FString, FString>>());
	void SetTalkName(const FString& Name);
	void SetTalkWords(const FString& Text);
	void SetTalkMine(const FString& Text);
	TSharedPtr<SEditableTextBox> GetTalkInput() const { return TalkInput; }
	/**
	 * The guide's answer, in the same bubble: what it says, the question under it, the buttons that start
	 * the trip (`Go`, drawn as the main buttons) and questions to ask next with one click (`Ask`).
	 * The typing line takes the next question.
	 */
	void ShowGuide(const FString& Words, const FString& Mine, const TArray<FString>& Go, const TArray<FString>& Ask);

	/**
	 * "What's new": a card in the middle of the screen with what has been added since the player was
	 * last here, newest first, a line under it (`Foot`, or nothing) and a button that puts it away.
	 */
	void ShowNews(bool bShow, const TArray<FEarthNewsEntry>& Entries = TArray<FEarthNewsEntry>(), const FString& Foot = FString());

private:
	TSharedRef<SWidget> ActionButton(const FEarthAction& Action, bool bOnStrip);
	void HandleAsked(const FText& Text, ETextCommit::Type How);
	void HandleTalked(const FText& Text, ETextCommit::Type How);

	TWeakObjectPtr<AEarthWalkHUD> Owner;
	TSharedPtr<SBorder> MenuPanel;
	TSharedPtr<SBorder> AskPanel;
	TSharedPtr<STextBlock> AskTitle;
	TSharedPtr<SEditableTextBox> AskInput;
	TSharedPtr<class SWrapBox> AskChoices;
	TSharedPtr<SWidget> Strip;
	TSharedPtr<SBorder> NewsPanel;
	TSharedPtr<SBorder> ChoicePanel;
	TSharedPtr<SBorder> TalkPanel;
	TSharedPtr<STextBlock> TalkName;
	TSharedPtr<STextBlock> TalkWords;
	TSharedPtr<STextBlock> TalkMine;
	TSharedPtr<class SWrapBox> TalkReplies;
	TSharedPtr<SEditableTextBox> TalkInput;
	// Cream paper with an ink line round it, like the bubbles over the things themselves.
	FSlateRoundedBoxBrush TalkBrush = FSlateRoundedBoxBrush(FLinearColor(FColor(255, 253, 244, 250)), 16.f, FLinearColor(FColor(38, 34, 31)), 2.5f);
	FButtonStyle ReplyButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(38, 34, 31, 28)), 9.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(245, 197, 24, 255)), 9.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(220, 170, 10, 255)), 9.f));

	// The buttons under an answer of the guide that take you somewhere: yellow, as the keys are.
	FButtonStyle GoButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(245, 197, 24, 255)), 9.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 216, 77, 255)), 9.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(220, 170, 10, 255)), 9.f));

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
