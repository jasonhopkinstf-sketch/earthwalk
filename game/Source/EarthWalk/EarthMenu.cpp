#include "EarthMenu.h"

#include "EarthWalkHUD.h"
#include "Styling/CoreStyle.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
	const FLinearColor PanelColor(FColor(22, 28, 38, 240));
	const FLinearColor DimColor(1.f, 1.f, 1.f, 0.62f);
	const FLinearColor KeyInk(FColor(38, 34, 31));
	const FLinearColor GoldColor(FColor(245, 197, 24));
	const FLinearColor PaperInk(FColor(38, 34, 31));
	const FLinearColor PaperDim(FColor(38, 34, 31, 150));
	const FLinearColor PaperName(FColor(138, 79, 45));

	// Everything a player can do, in the order the menu shows it. A new thing to do is one line here
	// (and, when it is not a chat command already, a few in AEarthWalkHUD::MenuAction).
	const FEarthAction Table[] = {
		{ TEXT("goto"), TEXT("Go somewhere"), TEXT("Go to a place..."), TEXT("Anywhere on Earth: a town, a street, a famous place."), TEXT(""), TEXT("goto"), TEXT("Where to?"), TEXT("Sydney Opera House"), TEXT("Go to...") },
		{ TEXT("shows"), TEXT("Go somewhere"), TEXT("Show me..."), TEXT("A list of things to see and do, and straight to the one you pick."), TEXT("G"), TEXT(""), TEXT(""), TEXT(""), TEXT("Show me") },
		{ TEXT("join"), TEXT("Go somewhere"), TEXT("Go to a friend..."), TEXT("Lands you beside somebody in your room."), TEXT(""), TEXT("join"), TEXT("Who do you want to go to?"), TEXT("their name"), TEXT("") },
		{ TEXT("who"), TEXT("Go somewhere"), TEXT("Who is here?"), TEXT("Lists everybody in your room and how far off they are."), TEXT(""), TEXT("who"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("where"), TEXT("Go somewhere"), TEXT("Where am I?"), TEXT("Says where on Earth you are standing."), TEXT(""), TEXT("where"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("house"), TEXT("Go somewhere"), TEXT("Find a house to go into"), TEXT("Says where the nearest front door that opens is."), TEXT(""), TEXT("house"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("fly"), TEXT("Go somewhere"), TEXT("Fly, or land"), TEXT("Up into the air and down again."), TEXT("F"), TEXT("fly"), TEXT(""), TEXT(""), TEXT("") },

		{ TEXT("ride"), TEXT("Ride and drive"), TEXT("Hop on, or hop off"), TEXT("The nearest animal, car, tractor, boat or train. At a door with a COME IN sign, go in."), TEXT("E"), TEXT(""), TEXT(""), TEXT(""), TEXT("Ride") },
		{ TEXT("car"), TEXT("Ride and drive"), TEXT("Call my car"), TEXT("Your own car drives to where you are."), TEXT(""), TEXT("car"), TEXT(""), TEXT(""), TEXT("My car") },
		{ TEXT("caraway"), TEXT("Ride and drive"), TEXT("Send my car away"), TEXT("It goes back to wherever it waits."), TEXT(""), TEXT("car away"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("taketo"), TEXT("Ride and drive"), TEXT("Take me to..."), TEXT("On an animal or in a car: tell it where, and it carries you there by itself."), TEXT(""), TEXT(""), TEXT("Where should it take you?"), TEXT("the beach"), TEXT("") },
		{ TEXT("taxi"), TEXT("Ride and drive"), TEXT("Call a taxi..."), TEXT("It comes to you and drives you there. Press E beside it to get in."), TEXT(""), TEXT("taxi"), TEXT("Where should the taxi take you?"), TEXT("the beach"), TEXT("Taxi...") },

		{ TEXT("talk"), TEXT("Talk"), TEXT("Talk to what is nearest"), TEXT("Animals, cars, trains, trees and houses all answer. Tell one what to do: follow me, stay, take me to the beach."), TEXT("T"), TEXT(""), TEXT(""), TEXT(""), TEXT("Talk") },
		{ TEXT("chat"), TEXT("Talk"), TEXT("Chat with people"), TEXT("Everybody in your room reads what you type."), TEXT("Enter"), TEXT(""), TEXT(""), TEXT(""), TEXT("") },

		{ TEXT("passport"), TEXT("Play"), TEXT("My passport"), TEXT("Today's tasks, treasure hunts, expeditions, coins, hats, riddles and everywhere you have been."), TEXT("P"), TEXT(""), TEXT(""), TEXT(""), TEXT("Passport") },
		{ TEXT("race"), TEXT("Play"), TEXT("A race"), TEXT("Sets a race up along the roads here, joins a friend's, or starts yours."), TEXT("R"), TEXT(""), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("racestop"), TEXT("Play"), TEXT("Leave the race"), TEXT("Leaves it, or ends your own."), TEXT(""), TEXT("race stop"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("clue"), TEXT("Play"), TEXT("Hear the clue again"), TEXT("The clue of the treasure hunt you are on."), TEXT(""), TEXT("clue"), TEXT(""), TEXT(""), TEXT("") },

		{ TEXT("animal"), TEXT("Me"), TEXT("Change my animal..."), TEXT("Fox, bear, rabbit, cat, owl or frog."), TEXT(""), TEXT("animal"), TEXT("Which animal? Fox, bear, rabbit, cat, owl or frog"), TEXT("bear"), TEXT("") },
		{ TEXT("name"), TEXT("Me"), TEXT("Change my name..."), TEXT("What other people see over your head."), TEXT(""), TEXT("name"), TEXT("What should people call you?"), TEXT("your name"), TEXT("") },
		{ TEXT("home"), TEXT("Me"), TEXT("Make this my home"), TEXT("You start here next time (when you are signed in)."), TEXT(""), TEXT("home"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("room"), TEXT("Me"), TEXT("Change room..."), TEXT("People in the same room see each other."), TEXT(""), TEXT("room"), TEXT("Which room?"), TEXT("family"), TEXT("") },
		{ TEXT("login"), TEXT("Me"), TEXT("Sign in with Google"), TEXT("Opens your browser. Keeps your passport, coins and home."), TEXT(""), TEXT("login"), TEXT(""), TEXT(""), TEXT("") },

		{ TEXT("look"), TEXT("The game"), TEXT("Switch the look"), TEXT("Between the painted look and the flat cartoon look."), TEXT(""), TEXT(""), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("sound"), TEXT("The game"), TEXT("Sounds on, or off"), TEXT("The animals' voices, car horns and train whistles."), TEXT(""), TEXT(""), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("map"), TEXT("The game"), TEXT("The little map: bigger, or hidden"), TEXT("The map in the corner: friends, doors, trains, cars and where you are going."), TEXT("M"), TEXT(""), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("strip"), TEXT("The game"), TEXT("Buttons on, or off"), TEXT("The row of buttons along the bottom of the screen."), TEXT("Z"), TEXT(""), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("help"), TEXT("The game"), TEXT("Every typed command"), TEXT("Lists the slash commands in the chat window, for those who like typing."), TEXT(""), TEXT("help"), TEXT(""), TEXT(""), TEXT("") },
		{ TEXT("quit"), TEXT("The game"), TEXT("Leave EarthWalk"), TEXT("Where you are is remembered for next time."), TEXT("Esc Esc"), TEXT("quit"), TEXT(""), TEXT(""), TEXT("") },
	};

	TSharedRef<STextBlock> Line(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Color, float Wrap = 0.f)
	{
		return SNew(STextBlock)
			.Font(FCoreStyle::GetDefaultFontStyle(Face, Size))
			.ColorAndOpacity(Color)
			.WrapTextAt(Wrap)
			.Text(FText::FromString(Text));
	}
}

TConstArrayView<FEarthAction> EarthMenu::Actions()
{
	return TConstArrayView<FEarthAction>(Table, UE_ARRAY_COUNT(Table));
}

const FEarthAction* EarthMenu::Find(const FString& Id)
{
	for (const FEarthAction& Action : Table)
	{
		if (Id == Action.Id)
		{
			return &Action;
		}
	}
	return nullptr;
}

TSharedRef<SWidget> SEarthMenu::ActionButton(const FEarthAction& Action, bool bOnStrip)
{
	const TWeakObjectPtr<AEarthWalkHUD> Hud = Owner;
	const FString Id = Action.Id;
	const FString Key = Action.Key;
	// The key that does it, on a yellow cap like a key of the keyboard; nothing where there is none.
	const TSharedRef<SWidget> Cap = Key.IsEmpty() ? StaticCastSharedRef<SWidget>(SNew(SBox)) : StaticCastSharedRef<SWidget>(
		SNew(SBorder)
		.BorderImage(&KeyBrush)
		.BorderBackgroundColor(FLinearColor::White)
		.Padding(FMargin(6.f, 1.f, 6.f, 2.f))
		[
			Line(Key, TEXT("Bold"), bOnStrip ? 10 : 11, KeyInk)
		]);
	const TSharedRef<SWidget> Body = bOnStrip
		? StaticCastSharedRef<SWidget>(
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, Key.IsEmpty() ? 0.f : 7.f, 0.f)[Cap]
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[Line(Action.Strip, TEXT("Bold"), 12, FLinearColor::White)])
		: StaticCastSharedRef<SWidget>(
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().FillWidth(1.f)
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[Line(Action.Title, TEXT("Bold"), 13, FLinearColor::White)]
				+ SVerticalBox::Slot().AutoHeight()[Line(Action.About, TEXT("Regular"), 10, DimColor, 300.f)]
			]
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)[Cap]);
	return SNew(SButton)
		.IsFocusable(false) // a click must not take the keyboard from the game
		.ButtonStyle(bOnStrip ? &StripButton : &RowButton)
		.ContentPadding(bOnStrip ? FMargin(11.f, 6.f) : FMargin(10.f, 6.f))
		.OnClicked_Lambda([Hud, Id]()
		{
			if (AEarthWalkHUD* Screen = Hud.Get())
			{
				Screen->MenuAction(Id);
			}
			return FReply::Handled();
		})
		[
			Body
		];
}

void SEarthMenu::Construct(const FArguments&, AEarthWalkHUD* InOwner)
{
	Owner = InOwner;

	// The strip: the menu itself first, then the few things done most.
	const TSharedRef<SHorizontalBox> Buttons = SNew(SHorizontalBox);
	const TWeakObjectPtr<AEarthWalkHUD> Hud = Owner;
	Buttons->AddSlot().AutoWidth().Padding(0.f, 0.f, 6.f, 0.f)
	[
		SNew(SButton)
		.IsFocusable(false)
		.ButtonStyle(&StripButton)
		.ContentPadding(FMargin(11.f, 6.f))
		.OnClicked_Lambda([Hud]()
		{
			if (AEarthWalkHUD* Screen = Hud.Get())
			{
				Screen->ToggleMenu();
			}
			return FReply::Handled();
		})
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 7.f, 0.f)
			[
				SNew(SBorder).BorderImage(&KeyBrush).BorderBackgroundColor(FLinearColor::White).Padding(FMargin(6.f, 1.f, 6.f, 2.f))
				[
					Line(TEXT("Tab"), TEXT("Bold"), 10, KeyInk)
				]
			]
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[Line(TEXT("Everything"), TEXT("Bold"), 12, FLinearColor::White)]
		]
	];
	for (const FEarthAction& Action : Table)
	{
		if (Action.Strip[0])
		{
			Buttons->AddSlot().AutoWidth().Padding(0.f, 0.f, 6.f, 0.f)[ActionButton(Action, true)];
		}
	}
	Strip = Buttons;

	// The menu: a box for each group, two across.
	const TSharedRef<SWrapBox> Groups = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(16.0, 12.0));
	FString Group;
	TSharedPtr<SVerticalBox> Column;
	for (const FEarthAction& Action : Table)
	{
		if (Group != Action.Group)
		{
			Group = Action.Group;
			Groups->AddSlot()
			[
				SNew(SBox).WidthOverride(402.f)
				[
					SAssignNew(Column, SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight().Padding(2.f, 0.f, 0.f, 4.f)[Line(Group.ToUpper(), TEXT("Bold"), 11, GoldColor)]
				]
			];
		}
		Column->AddSlot().AutoHeight().Padding(0.f, 0.f, 0.f, 4.f)[ActionButton(Action, false)];
	}

	ChildSlot
	[
		SNew(SOverlay)
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(0.f, 0.f, 10.f, 40.f)
		[
			Buttons
		]
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
		[
			SAssignNew(MenuPanel, SBorder)
			.BorderImage(&PanelBrush)
			.BorderBackgroundColor(PanelColor)
			.Padding(FMargin(26.f, 18.f, 26.f, 20.f))
			.Visibility(EVisibility::Collapsed)
			[
				SNew(SBox).WidthOverride(852.f).MaxDesiredHeight(660.f) // two groups across, and room for the bar that scrolls
				[
					SNew(SScrollBox)
					+ SScrollBox::Slot()
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().FillWidth(1.f)[Line(TEXT("What would you like to do?"), TEXT("Bold"), 24, FLinearColor::White)]
						+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[Line(TEXT("Tab or Esc to close"), TEXT("Regular"), 10, DimColor)]
					]
					+ SScrollBox::Slot().Padding(0.f, 2.f, 0.f, 12.f)
					[
						Line(TEXT("Click one. The yellow key beside it does the same thing without this list."), TEXT("Regular"), 12, DimColor)
					]
					+ SScrollBox::Slot()
					[
						Groups
					]
				]
			]
		]
		// The conversation with a thing: a speech bubble at the foot of the screen.
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(0.f, 0.f, 0.f, 84.f)
		[
			SAssignNew(TalkPanel, SBorder)
			.BorderImage(&TalkBrush)
			.BorderBackgroundColor(FLinearColor::White)
			.Padding(FMargin(20.f, 12.f, 20.f, 14.f))
			.Visibility(EVisibility::Collapsed)
			[
				SNew(SBox).WidthOverride(560.f)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().FillWidth(1.f)
						[
							SAssignNew(TalkName, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 15)).ColorAndOpacity(PaperName)
						]
						+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[Line(TEXT("Esc to finish"), TEXT("Regular"), 10, PaperDim)]
					]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 0.f)
					[
						SAssignNew(TalkWords, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 16)).ColorAndOpacity(PaperInk).WrapTextAt(556.f)
					]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
					[
						SAssignNew(TalkMine, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Italic", 11)).ColorAndOpacity(PaperDim).WrapTextAt(556.f)
					]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 8.f, 0.f, 0.f)
					[
						SAssignNew(TalkReplies, SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(6.0, 6.0))
					]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 10.f, 0.f, 0.f)
					[
						SAssignNew(TalkInput, SEditableTextBox)
						.Font(FCoreStyle::GetDefaultFontStyle("Regular", 14))
						.ClearKeyboardFocusOnCommit(false)
						.OnTextCommitted(this, &SEarthMenu::HandleTalked)
					]
				]
			]
		]
		// The question an action asks: where to, who, which.
		+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Top).Padding(0.f, 170.f, 0.f, 0.f)
		[
			SAssignNew(AskPanel, SBorder)
			.BorderImage(&PanelBrush)
			.BorderBackgroundColor(PanelColor)
			.Padding(FMargin(22.f, 16.f, 22.f, 16.f))
			.Visibility(EVisibility::Collapsed)
			[
				SNew(SBox).WidthOverride(540.f)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()
					[
						SAssignNew(AskTitle, STextBlock)
						.Font(FCoreStyle::GetDefaultFontStyle("Bold", 18))
						.ColorAndOpacity(FLinearColor::White)
						.WrapTextAt(540.f)
					]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 10.f, 0.f, 8.f)
					[
						SAssignNew(AskInput, SEditableTextBox)
						.Font(FCoreStyle::GetDefaultFontStyle("Regular", 15))
						.ClearKeyboardFocusOnCommit(false)
						.OnTextCommitted(this, &SEarthMenu::HandleAsked)
					]
					+ SVerticalBox::Slot().AutoHeight()
					[
						Line(TEXT("Enter to go. Esc to change your mind."), TEXT("Regular"), 11, DimColor)
					]
				]
			]
		]
	];
	// The pointer passes through to the game everywhere but on a button.
	SetVisibility(EVisibility::SelfHitTestInvisible);
}

void SEarthMenu::ShowMenu(bool bShow)
{
	MenuPanel->SetVisibility(bShow ? EVisibility::Visible : EVisibility::Collapsed);
}

void SEarthMenu::ShowStrip(bool bShow)
{
	Strip->SetVisibility(bShow ? EVisibility::SelfHitTestInvisible : EVisibility::Collapsed);
}

void SEarthMenu::ShowAsk(const FEarthAction* Action)
{
	AskPanel->SetVisibility(Action ? EVisibility::Visible : EVisibility::Collapsed);
	if (Action)
	{
		AskTitle->SetText(FText::FromString(Action->Ask));
		AskInput->SetText(FText::GetEmpty());
		AskInput->SetHintText(FText::FromString(FString::Printf(TEXT("for example: %s"), Action->AskHint)));
	}
}

void SEarthMenu::ShowTalk(bool bShow, const FString& Name, const TArray<TPair<FString, FString>>& Replies)
{
	TalkPanel->SetVisibility(bShow ? EVisibility::Visible : EVisibility::Collapsed);
	if (!bShow)
	{
		return;
	}
	SetTalkName(Name);
	TalkWords->SetText(FText::FromString(TEXT("...")));
	SetTalkMine(FString());
	TalkInput->SetText(FText::GetEmpty());
	TalkReplies->ClearChildren();
	const TWeakObjectPtr<AEarthWalkHUD> Hud = Owner;
	for (const TPair<FString, FString>& Reply : Replies)
	{
		const FString Words = Reply.Value;
		TalkReplies->AddSlot()
		[
			SNew(SButton)
			.IsFocusable(false) // the typing line keeps the keyboard
			.ButtonStyle(&ReplyButton)
			.ContentPadding(FMargin(10.f, 4.f))
			.OnClicked_Lambda([Hud, Words]()
			{
				if (AEarthWalkHUD* Screen = Hud.Get())
				{
					if (Words == TEXT("..."))
					{
						Screen->MenuAction(TEXT("taketo"));
					}
					else
					{
						Screen->TalkSay(Words);
					}
				}
				return FReply::Handled();
			})
			[
				Line(Reply.Key, TEXT("Bold"), 11, PaperInk)
			]
		];
	}
}

void SEarthMenu::SetTalkName(const FString& Name)
{
	TalkName->SetText(FText::FromString(Name));
	TalkInput->SetHintText(FText::FromString(FString::Printf(TEXT("Say something to %s, and press Enter"), *Name)));
}

void SEarthMenu::SetTalkWords(const FString& Text)
{
	TalkWords->SetText(FText::FromString(Text));
}

void SEarthMenu::SetTalkMine(const FString& Text)
{
	TalkMine->SetVisibility(Text.IsEmpty() ? EVisibility::Collapsed : EVisibility::HitTestInvisible);
	TalkMine->SetText(FText::FromString(Text));
}

void SEarthMenu::HandleTalked(const FText& Text, ETextCommit::Type How)
{
	AEarthWalkHUD* Hud = Owner.Get();
	if (!Hud)
	{
		return;
	}
	// Enter says it and leaves the line ready for the next thing; Esc ends the conversation.
	if (How == ETextCommit::OnEnter)
	{
		const FString Typed = Text.ToString().TrimStartAndEnd();
		TalkInput->SetText(FText::GetEmpty());
		if (!Typed.IsEmpty())
		{
			Hud->TalkSay(Typed);
		}
	}
	else if (How == ETextCommit::OnCleared)
	{
		Hud->EndTalk();
	}
}

void SEarthMenu::HandleAsked(const FText& Text, ETextCommit::Type How)
{
	AEarthWalkHUD* Hud = Owner.Get();
	if (!Hud)
	{
		return;
	}
	// Enter with something typed is the answer, and Esc (or Enter with nothing) a change of mind. A click
	// somewhere else, or another window coming to the front, is neither: the box stays, and the game
	// gives it the keyboard back (AEarthWalkHUD::Tick).
	if (How == ETextCommit::OnEnter)
	{
		Hud->AskDone(Text.ToString().TrimStartAndEnd());
	}
	else if (How == ETextCommit::OnCleared)
	{
		Hud->AskDone(FString());
	}
}
