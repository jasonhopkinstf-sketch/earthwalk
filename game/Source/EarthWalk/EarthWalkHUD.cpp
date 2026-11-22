#include "EarthWalkHUD.h"

#include "EarthMenu.h"
#include "EarthAnimalFigure.h"
#include "EarthCompany.h"
#include "EarthLife.h"
#include "EarthLook.h"
#include "EarthShowcase.h"
#include "EarthSounds.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Dom/JsonObject.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HttpModule.h"
#include "InputCoreTypes.h"
#include "Misc/CommandLine.h"
#include "Misc/ConfigCacheIni.h"
#include "Kismet/KismetSystemLibrary.h"
#include "Misc/Parse.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Brushes/SlateRoundedBoxBrush.h"
#include "Styling/CoreStyle.h"
#include "Widgets/DeclarativeSyntaxSupport.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/Notifications/SProgressBar.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCanvas.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
	/** ProjectVersion from DefaultGame.ini, so a build can be told apart on screen. */
	FString GameVersion()
	{
		FString Version;
		if (GConfig)
		{
			GConfig->GetString(TEXT("/Script/EngineSettings.GeneralProjectSettings"), TEXT("ProjectVersion"), Version, GGameIni);
		}
		return Version.IsEmpty() ? FString(TEXT("dev")) : Version;
	}

	const FLinearColor NoticeColor(0.75f, 0.9f, 1.f);
	const FLinearColor ErrorColor(1.f, 0.6f, 0.5f);
	// The header's panel (the browser's --panel), and the blue it flashes on arriving somewhere new.
	const FLinearColor PanelColor(FColor(18, 22, 28, 199));
	const FLinearColor ArrivedColor(FColor(47, 111, 176, 235));
	constexpr double ArrivedSeconds = 1.6;
	constexpr double WhereDelaySeconds = 1.2; // wait this long in a new square before asking its name
	constexpr int32 MaxLines = 80;
	// What a thing said: a little warmer than the notices, so a conversation can be followed in the log.
	const FLinearColor ThingColor(1.f, 0.9f, 0.62f);
	// Speech bubbles: cream paper, dark ink, the speaker's name in brown (the browser's bubble).
	const FLinearColor BubblePaper(FColor(255, 253, 244, 245));
	const FLinearColor BubbleInk(FColor(38, 34, 31));
	const FLinearColor BubbleName(FColor(138, 79, 45));
	// The passport.
	const FLinearColor PassportPanel(FColor(18, 22, 28, 240));
	const FLinearColor CardColor(FColor(255, 255, 255, 20));
	const FLinearColor CardDoneColor(FColor(214, 168, 62, 70));
	const FLinearColor GoldColor(FColor(240, 200, 96));
	const FLinearColor DimColor(1.f, 1.f, 1.f, 0.62f);
	constexpr double ToastSeconds = 4.2;

	/** 12 or 12.3: a count as the server sent it, without a tail of noughts. */
	FString ShortCount(double Value)
	{
		return FMath::IsNearlyEqual(Value, FMath::RoundToDouble(Value), 0.001) ? FString::Printf(TEXT("%d"), FMath::RoundToInt32(Value)) : FString::Printf(TEXT("%.1f"), Value);
	}
	FString DateOf(double Ms)
	{
		return FDateTime::FromUnixTimestamp(static_cast<int64>(Ms / 1000.0)).ToFormattedString(TEXT("%e %b %Y"));
	}
	double JsonNum(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		double Value = 0.0;
		if (Json.IsValid())
		{
			Json->TryGetNumberField(Field, Value);
		}
		return Value;
	}
	FString JsonStr(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		FString Value;
		if (Json.IsValid())
		{
			Json->TryGetStringField(Field, Value);
		}
		return Value;
	}
	/** "3 countries", "1 country": the stamps count in their own units. */
	FString CountedIn(double N, const FString& Unit)
	{
		if (Unit.IsEmpty())
		{
			return ShortCount(N);
		}
		static const TMap<FString, FString> One = {
			{ TEXT("countries"), TEXT("country") }, { TEXT("continents"), TEXT("continent") }, { TEXT("places"), TEXT("place") },
			{ TEXT("friends"), TEXT("friend") }, { TEXT("kinds"), TEXT("kind") },
		};
		const FString* Single = One.Find(Unit);
		return FString::Printf(TEXT("%s %s"), *ShortCount(N), N == 1.0 && Single ? **Single : *Unit);
	}
	/** What a piece of news is about, for the top of its card and its line in the log. */
	const TCHAR* NewsLabel(const FString& Kind)
	{
		return Kind == TEXT("country") ? TEXT("New country") : Kind == TEXT("level") ? TEXT("Level up") : Kind == TEXT("riddle") ? TEXT("Riddles")
			: Kind == TEXT("task") ? TEXT("Today") : Kind == TEXT("prize") ? TEXT("A prize") : Kind == TEXT("favour") ? TEXT("A favour")
			: Kind == TEXT("hunt") ? TEXT("Treasure hunt") : Kind == TEXT("expedition") ? TEXT("Expedition") : Kind == TEXT("race") ? TEXT("Race") : TEXT("New stamp");
	}
	/** The objects in a list inside a JSON object; none when the field is missing or null. */
	TArray<TSharedPtr<FJsonObject>> JsonRows(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		TArray<TSharedPtr<FJsonObject>> Out;
		const TArray<TSharedPtr<FJsonValue>>* Found = nullptr;
		if (Json.IsValid() && Json->TryGetArrayField(Field, Found))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Found)
			{
				const TSharedPtr<FJsonObject>* Row = nullptr;
				if (Value.IsValid() && Value->TryGetObject(Row))
				{
					Out.Add(*Row);
				}
			}
		}
		return Out;
	}
	TSharedRef<STextBlock> WrappedLine(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Color, float WrapAt)
	{
		return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Color).WrapTextAt(WrapAt).Text(FText::FromString(Text));
	}
	TSharedRef<STextBlock> TextLine(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Color)
	{
		return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Color).Text(FText::FromString(Text));
	}
}

/** The Slate widgets. Built in code so the project needs no editor-made assets. */
class SEarthWalkOverlay : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthWalkOverlay) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, AEarthWalkHUD* InOwner)
	{
		Owner = InOwner;
		const FSlateFontInfo Font = FCoreStyle::GetDefaultFontStyle("Regular", 13);

		ChildSlot
		[
			SNew(SOverlay)
			// Where am I: the name of the place, large, with the country and coordinates beneath.
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Top).Padding(0.f, 10.f, 0.f, 0.f)
			[
				SAssignNew(Where, SBorder)
				.BorderImage(&WhereBrush)
				.BorderBackgroundColor(TAttribute<FSlateColor>::CreateLambda([this]() { return FSlateColor(FMath::Lerp(ArrivedColor, PanelColor, FMath::Clamp(Arrived(), 0.f, 1.f))); }))
				.Padding(FMargin(22.f, 8.f, 22.f, 9.f))
				.Visibility(EVisibility::Collapsed)
				.RenderTransformPivot(FVector2D(0.5, 0.0))
				[
					SNew(SBox).MaxDesiredWidth(640.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
						[
							SAssignNew(WhereName, STextBlock)
							.Font(FCoreStyle::GetDefaultFontStyle("Bold", 24))
							.ColorAndOpacity(FLinearColor::White)
							.WrapTextAt(596.f) // a long name runs to a second line rather than across the whole screen
							.Justification(ETextJustify::Center)
						]
						+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center).Padding(0.f, 2.f, 0.f, 0.f)
						[
							SAssignNew(WhereSub, STextBlock)
							.Font(FCoreStyle::GetDefaultFontStyle("Regular", 12))
							.ColorAndOpacity(FLinearColor(1.f, 1.f, 1.f, 0.8f))
							.Justification(ETextJustify::Center)
						]
					]
				]
			]
			// What things have said, each above the thing that said it.
			+ SOverlay::Slot()
			[
				SAssignNew(BubbleCanvas, SCanvas).Visibility(EVisibility::HitTestInvisible)
			]
			// What E and T would do just now.
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(0.f, 0.f, 0.f, 92.f)
			[
				SAssignNew(Hint, STextBlock)
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 15))
				.ColorAndOpacity(FLinearColor::White)
				.ShadowOffset(FVector2D(1.0, 1.0))
				.ShadowColorAndOpacity(FLinearColor(0.f, 0.f, 0.f, 0.9f))
				.Visibility(EVisibility::Collapsed)
			]
			// The race: who is in and how far along, under the status line; and the countdown, large, in the middle.
			+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(16.f, 44.f, 0.f, 0.f)
			[
				SAssignNew(RacePanel, SBorder)
				.BorderImage(&WhereBrush)
				.BorderBackgroundColor(PanelColor)
				.Padding(FMargin(12.f, 8.f))
				.Visibility(EVisibility::Collapsed)
				[
					SAssignNew(RaceText, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 12)).ColorAndOpacity(FLinearColor::White)
				]
			]
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center).Padding(0.f, 0.f, 0.f, 120.f)
			[
				SAssignNew(RaceCount, STextBlock)
				.Font(FCoreStyle::GetDefaultFontStyle("Bold", 96))
				.ColorAndOpacity(FLinearColor::White)
				.ShadowOffset(FVector2D(3.0, 3.0))
				.ShadowColorAndOpacity(FLinearColor(0.f, 0.f, 0.f, 0.85f))
				.Visibility(EVisibility::Collapsed)
			]
			// A stamp just earned, for a few seconds.
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Top).Padding(0.f, 96.f, 0.f, 0.f)
			[
				SAssignNew(Toast, SBorder)
				.BorderImage(&ToastBrush)
				.BorderBackgroundColor(FLinearColor::White)
				.Padding(FMargin(20.f, 10.f))
				.Visibility(EVisibility::Collapsed)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
					[
						SAssignNew(ToastLabel, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 11)).ColorAndOpacity(BubbleName)
					]
					+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
					[
						SAssignNew(ToastTitle, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 20)).ColorAndOpacity(BubbleInk)
					]
					+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)
					[
						SAssignNew(ToastText, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 12)).ColorAndOpacity(BubbleInk)
					]
				]
			]
			// The passport, in the middle of the screen while it is open.
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
			[
				SAssignNew(Passport, SBorder)
				.BorderImage(&WhereBrush)
				.BorderBackgroundColor(PassportPanel)
				.Padding(FMargin(26.f, 20.f))
				.Visibility(EVisibility::Collapsed)
				[
					SNew(SBox).WidthOverride(800.f).MaxDesiredHeight(610.f)
					[
						SAssignNew(PassportBody, SScrollBox)
					]
				]
			]
			// Show me: the things to show somebody, in the middle of the screen while the list is open.
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
			[
				SAssignNew(ShowsPanel, SBorder)
				.BorderImage(&WhereBrush)
				.BorderBackgroundColor(PassportPanel)
				.Padding(FMargin(26.f, 20.f))
				.Visibility(EVisibility::Collapsed)
				[
					SNew(SBox).WidthOverride(800.f).MaxDesiredHeight(720.f)
					[
						SAssignNew(ShowsBody, SScrollBox)
					]
				]
			]
			+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(16.f)
			[
				SAssignNew(Status, STextBlock)
				.Font(Font)
				.ColorAndOpacity(FLinearColor::White)
				.ShadowOffset(FVector2D(1.0, 1.0))
				.ShadowColorAndOpacity(FLinearColor(0.f, 0.f, 0.f, 0.85f))
			]
			+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(16.f)
			[
				SAssignNew(Credit, STextBlock)
				.Font(FCoreStyle::GetDefaultFontStyle("Regular", 10))
				.ColorAndOpacity(FLinearColor(1.f, 1.f, 1.f, 0.7f))
				.ShadowOffset(FVector2D(1.0, 1.0))
				.ShadowColorAndOpacity(FLinearColor(0.f, 0.f, 0.f, 0.85f))
				.Text(FText::FromString(CreditText(false)))
			]
			// In the photographic world the plugin writes Google's credits along the bottom left, and they
			// have to stay readable, so the chat moves up out of their way.
			+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Bottom)
			.Padding(TAttribute<FMargin>::CreateLambda([this]() { return FMargin(16.f, 16.f, 16.f, bPhotoCredit ? 44.f : 16.f); }))
			[
				SAssignNew(ChatColumn, SBox).WidthOverride(560.f).Visibility(EVisibility::HitTestInvisible)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()
					[
						SNew(SBox).MaxDesiredHeight(280.f)
						[
							SAssignNew(Log, SScrollBox)
						]
					]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
					[
						SAssignNew(Input, SEditableTextBox)
						.Font(Font)
						.HintText(FText::FromString(TEXT("Press Enter to chat. Tab shows everything you can do. Esc twice to quit.")))
						.ClearKeyboardFocusOnCommit(true)
						.OnTextCommitted(this, &SEarthWalkOverlay::HandleCommitted)
					]
				]
			]
		];
	}

	void AddLine(const FString& Text, const FLinearColor& Color)
	{
		const TSharedRef<STextBlock> Line = SNew(STextBlock)
			.Font(FCoreStyle::GetDefaultFontStyle("Regular", 13))
			.AutoWrapText(true)
			.ColorAndOpacity(Color)
			.ShadowOffset(FVector2D(1.0, 1.0))
			.ShadowColorAndOpacity(FLinearColor(0.f, 0.f, 0.f, 0.85f))
			.Text(FText::FromString(Text));
		Log->AddSlot()[Line];
		Lines.Add(Line);
		while (Lines.Num() > MaxLines)
		{
			Log->RemoveSlot(Lines[0]);
			Lines.RemoveAt(0);
		}
		Log->ScrollToEnd();
	}

	void SetStatus(const FString& Text) { Status->SetText(FText::FromString(Text)); }

	void SetHint(const FString& Text)
	{
		Hint->SetVisibility(Text.IsEmpty() ? EVisibility::Collapsed : EVisibility::HitTestInvisible);
		Hint->SetText(FText::FromString(Text));
	}
	void SetInputHint(const FString& Text) { Input->SetHintText(FText::FromString(Text)); }
	void SetRace(const FString& Panel, const FString& Count)
	{
		RacePanel->SetVisibility(Panel.IsEmpty() ? EVisibility::Collapsed : EVisibility::HitTestInvisible);
		if (Panel != RaceShown)
		{
			RaceShown = Panel;
			RaceText->SetText(FText::FromString(Panel));
		}
		RaceCount->SetVisibility(Count.IsEmpty() ? EVisibility::Collapsed : EVisibility::HitTestInvisible);
		if (Count != CountShown)
		{
			CountShown = Count;
			RaceCount->SetText(FText::FromString(Count));
		}
	}

	/** The speech bubbles: one above each thing that has just spoken, the same size however far off it is. */
	void SetBubbles(const TArray<UEarthCompany::FBubble>& Bubbles, const APlayerController* PC)
	{
		bool bSame = Bubbles.Num() == Shown.Num();
		for (int32 i = 0; bSame && i < Bubbles.Num(); ++i)
		{
			bSame = Bubbles[i].Thing == Shown[i].Thing && Bubbles[i].Until == Shown[i].Until;
		}
		if (!bSame)
		{
			BubbleCanvas->ClearChildren();
			Shown.Reset();
			for (const UEarthCompany::FBubble& Bubble : Bubbles)
			{
				FShownBubble Entry;
				Entry.Thing = Bubble.Thing;
				Entry.Until = Bubble.Until;
				Entry.Where = Bubble.Where;
				Entry.At = MakeShared<FVector2D>(-10000.0, -10000.0);
				const TSharedRef<SWidget> Card = SNew(SBorder)
					.BorderImage(&BubbleBrush)
					.BorderBackgroundColor(FLinearColor::White)
					.Padding(FMargin(14.f, 8.f, 14.f, 10.f))
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							TextLine(Bubble.Name, TEXT("Bold"), 13, BubbleName)
						]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)
						[
							SNew(STextBlock)
							.Font(FCoreStyle::GetDefaultFontStyle("Regular", 14))
							.ColorAndOpacity(BubbleInk)
							.WrapTextAt(300.f)
							.Text(FText::FromString(Bubble.Text))
						]
					];
				Entry.Widget = Card;
				const TSharedPtr<FVector2D> At = Entry.At;
				const TWeakPtr<SWidget> Weak = Card;
				BubbleCanvas->AddSlot()
					.Position(TAttribute<FVector2D>::CreateLambda([At]() { return *At; }))
					.Size(TAttribute<FVector2D>::CreateLambda([Weak]() { const TSharedPtr<SWidget> Pinned = Weak.Pin(); return Pinned.IsValid() ? FVector2D(Pinned->GetDesiredSize()) : FVector2D::ZeroVector; }))
					.HAlign(HAlign_Center)
					.VAlign(VAlign_Bottom)
					[
						Card
					];
				Shown.Add(Entry);
			}
		}
		const double Now = FPlatformTime::Seconds();
		for (FShownBubble& Entry : Shown)
		{
			FVector2D Screen;
			const bool bOnScreen = PC && PC->ProjectWorldLocationToScreen(Entry.Where, Screen, false);
			Entry.Widget->SetVisibility(bOnScreen ? EVisibility::HitTestInvisible : EVisibility::Collapsed);
			if (bOnScreen)
			{
				*Entry.At = Screen / LayoutScale;
			}
			Entry.Widget->SetRenderOpacity(static_cast<float>(FMath::Clamp((Entry.Until - Now) / 0.6, 0.0, 1.0)));
		}
	}

	/** A stamp just earned: shown for a few seconds, one at a time. */
	void QueueToast(const FString& Kind, const FString& Title, const FString& Text)
	{
		Toasts.Add({ FString(NewsLabel(Kind)).ToUpper(), Title, Text });
	}

	void ShowPassport(bool bShow)
	{
		// The passport has buttons, so while it is open the pointer works on it.
		Passport->SetVisibility(bShow ? EVisibility::Visible : EVisibility::Collapsed);
		bPassportInteractive = bShow;
		ApplyInteractive();
		if (bShow)
		{
			PassportBody->ClearChildren();
			PassportBody->AddSlot()[TextLine(TEXT("Opening your passport..."), TEXT("Regular"), 14, FLinearColor::White)];
		}
	}
	void ScrollPassport(float By) { PassportBody->SetScrollOffset(FMath::Max(0.f, PassportBody->GetScrollOffset() + By)); }
	/** Draws the passport again from the journal it was last given: the player has become another animal. */
	void RedrawPassport()
	{
		if (LastJournal.IsValid())
		{
			const float Offset = PassportBody->GetScrollOffset();
			SetPassport(LastJournal);
			PassportBody->SetScrollOffset(Offset);
		}
	}

	/** The list of things to show: up or away, with a line to read while it is being asked for (or when it did not come). */
	void ShowShows(bool bShow, const FString& Message = FString())
	{
		ShowsPanel->SetVisibility(bShow ? EVisibility::Visible : EVisibility::Collapsed);
		bShowsInteractive = bShow;
		ApplyInteractive();
		if (bShow)
		{
			ShowsBody->ClearChildren();
			ShowsBody->AddSlot()[WrappedLine(Message, TEXT("Regular"), 14, FLinearColor::White, 780.f)];
		}
	}
	/** Fills the list: a card for each thing, to click, with the number that picks it. */
	void SetShows(const TArray<FEarthShow>& List)
	{
		ShowsBody->ClearChildren();
		ShowsBody->AddSlot()
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().FillWidth(1.f)[TextLine(TEXT("Show me..."), TEXT("Bold"), 26, FLinearColor::White)]
			+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[TextLine(TEXT("G or Esc to close"), TEXT("Regular"), 10, DimColor)]
		];
		ShowsBody->AddSlot().Padding(0.f, 2.f, 0.f, 12.f)
		[
			TextLine(TEXT("Pick one, and you are taken straight to it. Click it, or press its number."), TEXT("Regular"), 12, DimColor)
		];
		const TSharedRef<SWrapBox> Cards = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
		const TWeakObjectPtr<AEarthWalkHUD> Hud = Owner;
		for (int32 i = 0; i < List.Num(); ++i)
		{
			const FEarthShow& Show = List[i];
			const FString Id = Show.Id;
			const FString Number = i < 9 ? FString::FromInt(i + 1) : i == 9 ? FString(TEXT("0")) : FString();
			Cards->AddSlot()
			[
				SNew(SBox).WidthOverride(388.f)
				[
					SNew(SButton)
					.IsFocusable(false) // a click must not take the keyboard from the game
					.ButtonStyle(&ShowButton)
					.ContentPadding(FMargin(10.f, 7.f))
					.OnClicked_Lambda([Hud, Id]()
					{
						if (AEarthWalkHUD* Screen = Hud.Get())
						{
							Screen->ShowChosen(Id);
						}
						return FReply::Handled();
					})
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 10.f, 0.f)
						[
							SNew(SBox).WidthOverride(24.f).HAlign(HAlign_Center)[TextLine(Number, TEXT("Bold"), 18, GoldColor)]
						]
						+ SHorizontalBox::Slot().FillWidth(1.f)
						[
							SNew(SVerticalBox)
							+ SVerticalBox::Slot().AutoHeight()[TextLine(Show.Title, TEXT("Bold"), 13, FLinearColor::White)]
							+ SVerticalBox::Slot().AutoHeight()[WrappedLine(Show.Text, TEXT("Regular"), 11, FLinearColor::White, 320.f)]
							+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)[TextLine(Show.Place, TEXT("Regular"), 10, DimColor)]
						]
					]
				]
			];
		}
		ShowsBody->AddSlot()[Cards];
	}

	/** Fills the passport from the journal the server sent (docs/PROTOCOL.md, "Journal"); null when the server keeps none. */
	void SetPassport(const TSharedPtr<FJsonObject>& Journal)
	{
		PassportBody->ClearChildren();
		LastJournal = Journal;
		if (!Journal.IsValid())
		{
			PassportBody->AddSlot()[TextLine(TEXT("Passport"), TEXT("Bold"), 22, FLinearColor::White)];
			PassportBody->AddSlot()[TextLine(TEXT("This server is not keeping journals."), TEXT("Regular"), 13, DimColor)];
			return;
		}
		const auto Object = [&Journal](const TCHAR* Field)
		{
			const TSharedPtr<FJsonObject>* Found = nullptr;
			return Journal->TryGetObjectField(Field, Found) ? *Found : TSharedPtr<FJsonObject>();
		};
		const auto Rows = [&Journal](const TCHAR* Field)
		{
			TArray<TSharedPtr<FJsonObject>> Out;
			const TArray<TSharedPtr<FJsonValue>>* Found = nullptr;
			if (Journal->TryGetArrayField(Field, Found))
			{
				for (const TSharedPtr<FJsonValue>& Value : *Found)
				{
					const TSharedPtr<FJsonObject>* Row = nullptr;
					if (Value.IsValid() && Value->TryGetObject(Row))
					{
						Out.Add(*Row);
					}
				}
			}
			return Out;
		};

		// ---- the level, and how far to the next
		const TSharedPtr<FJsonObject> Level = Object(TEXT("level"));
		const double Points = JsonNum(Level, TEXT("points")), From = JsonNum(Level, TEXT("from")), Next = JsonNum(Level, TEXT("next"));
		const int32 LevelN = FMath::RoundToInt32(JsonNum(Level, TEXT("n")));
		PassportBody->AddSlot()
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().FillWidth(1.f)
			[
				TextLine(FString::Printf(TEXT("LEVEL %d"), LevelN), TEXT("Bold"), 12, GoldColor)
			]
			+ SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 18.f, 0.f)
			[
				TextLine(FString::Printf(TEXT("%s coins"), *ShortCount(JsonNum(Journal, TEXT("coins")))), TEXT("Bold"), 13, GoldColor)
			]
			+ SHorizontalBox::Slot().AutoWidth()
			[
				TextLine(TEXT("P or Esc to close  ·  wheel, PgUp and PgDn to scroll"), TEXT("Regular"), 10, DimColor)
			]
		];
		PassportBody->AddSlot()[TextLine(JsonStr(Level, TEXT("title")), TEXT("Bold"), 26, FLinearColor::White)];
		PassportBody->AddSlot().Padding(0.f, 6.f, 0.f, 4.f)
		[
			SNew(SBox).HeightOverride(10.f)
			[
				SNew(SProgressBar).Percent(static_cast<float>(FMath::Clamp((Points - From) / FMath::Max(1.0, Next - From), 0.0, 1.0))).FillColorAndOpacity(GoldColor)
			]
		];
		PassportBody->AddSlot()[TextLine(FString::Printf(TEXT("%s points  ·  %s more to level %d"), *ShortCount(Points), *ShortCount(Next - Points), LevelN + 1), TEXT("Regular"), 11, DimColor)];

		// ---- the totals
		const TSharedPtr<FJsonObject> Totals = Object(TEXT("totals"));
		const TSharedRef<SHorizontalBox> TotalsRow = SNew(SHorizontalBox);
		const auto Total = [&TotalsRow](double N, const TCHAR* What)
		{
			TotalsRow->AddSlot().FillWidth(1.f)
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)[TextLine(ShortCount(N), TEXT("Bold"), 22, FLinearColor::White)]
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Center)[TextLine(What, TEXT("Regular"), 11, DimColor)]
			];
		};
		const double Countries = JsonNum(Totals, TEXT("countries")), Continents = JsonNum(Totals, TEXT("continents")), Places = JsonNum(Totals, TEXT("places")), Friends = JsonNum(Totals, TEXT("friends"));
		Total(Countries, Countries == 1.0 ? TEXT("country") : TEXT("countries"));
		Total(Continents, Continents == 1.0 ? TEXT("continent") : TEXT("continents"));
		Total(Places, Places == 1.0 ? TEXT("place") : TEXT("places"));
		Total(JsonNum(Totals, TEXT("km")), TEXT("km on foot"));
		Total(JsonNum(Totals, TEXT("kmRidden")), TEXT("km ridden"));
		Total(Friends, Friends == 1.0 ? TEXT("friend made") : TEXT("friends made"));
		PassportBody->AddSlot().Padding(0.f, 14.f, 0.f, 10.f)[TotalsRow];

		// ---- buttons, cards and bars for the pages that follow
		const TWeakObjectPtr<AEarthWalkHUD> Hud = Owner;
		const auto Button = [Hud](const FString& Text, const TCHAR* What, const FString& Id) -> TSharedRef<SWidget>
		{
			const FString Action = What;
			return SNew(SButton)
				.IsFocusable(false) // a click must not take the keyboard from the game
				.ContentPadding(FMargin(9.f, 3.f))
				.ButtonColorAndOpacity(FLinearColor(0.35f, 0.6f, 1.f))
				.OnClicked_Lambda([Hud, Action, Id]()
				{
					if (AEarthWalkHUD* Screen = Hud.Get())
					{
						Screen->PassportAction(Action, Id);
					}
					return FReply::Handled();
				})
				[
					TextLine(Text, TEXT("Bold"), 10, FLinearColor::White)
				];
		};
		const auto Bar = [](double Have, double Goal) -> TSharedRef<SWidget>
		{
			return SNew(SBox).HeightOverride(7.f)
				[
					SNew(SProgressBar).Percent(static_cast<float>(FMath::Clamp(Have / FMath::Max(1.0, Goal), 0.0, 1.0))).FillColorAndOpacity(GoldColor)
				];
		};
		const auto Heading = [this](const TCHAR* Title)
		{
			PassportBody->AddSlot().Padding(0.f, 14.f, 0.f, 4.f)[TextLine(Title, TEXT("Bold"), 14, FLinearColor::White)];
		};
		const auto Note = [this](const FString& Text)
		{
			PassportBody->AddSlot().Padding(0.f, 4.f, 0.f, 0.f)[WrappedLine(Text, TEXT("Regular"), 10, DimColor, 780.f)];
		};
		const double Coins = JsonNum(Journal, TEXT("coins"));

		// ---- which animal I am: the six to choose from. Friends see the change at once.
		{
			Heading(TEXT("Your animal"));
			struct FAnimalChoice
			{
				const TCHAR* Id;
				const TCHAR* Label;
				uint32 Coat;
				uint32 Front;
			};
			// The same six, in the same colours, as ANIMALS in server/public/js/avatars.js.
			static const FAnimalChoice Six[] = {
				{ TEXT("fox"), TEXT("Fox"), 0xd9682b, 0xf4ede2 }, { TEXT("bear"), TEXT("Bear"), 0x7a5234, 0xb08a63 }, { TEXT("rabbit"), TEXT("Rabbit"), 0xe6e0d6, 0xffffff },
				{ TEXT("cat"), TEXT("Cat"), 0x5d6270, 0xc9ccd4 }, { TEXT("owl"), TEXT("Owl"), 0x8a6b4a, 0xd9c7a8 }, { TEXT("frog"), TEXT("Frog"), 0x5fae4e, 0xd8e8a8 },
			};
			const auto Paint = [](uint32 Hex) { return FLinearColor::FromSRGBColor(FColor((Hex >> 16) & 0xff, (Hex >> 8) & 0xff, Hex & 0xff)); };
			const FString Mine = FEarthWalkConfig::Avatar();
			const TSharedRef<SWrapBox> Animals = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
			for (const FAnimalChoice& Animal : Six)
			{
				const bool bOn = Mine == Animal.Id;
				const FString Kind = FString(Animal.Label).ToLower();
				const bool bVowel = Kind.StartsWith(TEXT("a")) || Kind.StartsWith(TEXT("e")) || Kind.StartsWith(TEXT("i")) || Kind.StartsWith(TEXT("o")) || Kind.StartsWith(TEXT("u"));
				Animals->AddSlot()
				[
					SNew(SBox).WidthOverride(122.f)
					[
						SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bOn ? CardDoneColor : CardColor).Padding(FMargin(10.f, 8.f))
						[
							SNew(SVerticalBox)
							// Its coat, with the paler colour of its front let into it.
							+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left)
							[
								SNew(SBox).WidthOverride(46.f).HeightOverride(32.f)
								[
									SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(Paint(Animal.Coat)).Padding(FMargin(13.f, 13.f, 13.f, 0.f))
									[
										SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(Paint(Animal.Front))
									]
								]
							]
							+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 5.f, 0.f, 0.f)[TextLine(Animal.Label, TEXT("Bold"), 12, FLinearColor::White)]
							+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 0.f).HAlign(HAlign_Left)
							[
								bOn ? StaticCastSharedRef<SWidget>(TextLine(TEXT("This is you"), TEXT("Regular"), 10, DimColor))
									: Button(FString::Printf(TEXT("Be %s %s"), bVowel ? TEXT("an") : TEXT("a"), *Kind), TEXT("animal"), Animal.Id)
							]
						]
					]
				];
			}
			PassportBody->AddSlot()[Animals];
			Note(TEXT("Choose one and you are that animal from then on, for everyone, and the next time you come."));
		}

		// ---- today: three tasks, the same for everyone whose day it is
		const TSharedPtr<FJsonObject> Today = Object(TEXT("today"));
		if (Today.IsValid())
		{
			Heading(TEXT("Today"));
			const TSharedRef<SWrapBox> Tasks = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
			const FString CoinsEach = ShortCount(JsonNum(Today, TEXT("coinsEach")));
			for (const TSharedPtr<FJsonObject>& Task : JsonRows(Today, TEXT("tasks")))
			{
				bool bDone = false;
				Task->TryGetBoolField(TEXT("done"), bDone);
				const double Have = JsonNum(Task, TEXT("have")), Goal = JsonNum(Task, TEXT("goal"));
				const FString Progress = bDone ? FString::Printf(TEXT("Done: %s coins"), *CoinsEach)
					: Goal > 1.0 ? FString::Printf(TEXT("%s of %s%s"), *ShortCount(Have), *ShortCount(Goal), JsonStr(Task, TEXT("unit")) == TEXT("m") ? TEXT(" m") : TEXT(""))
					: FString(TEXT("Not yet"));
				Tasks->AddSlot()
				[
					SNew(SBox).WidthOverride(254.f)
					[
						SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bDone ? CardDoneColor : CardColor).Padding(FMargin(10.f, 7.f))
						[
							SNew(SVerticalBox)
							+ SVerticalBox::Slot().AutoHeight()[WrappedLine(JsonStr(Task, TEXT("text")), TEXT("Bold"), 12, FLinearColor::White, 232.f)]
							+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 5.f, 0.f, 3.f)[Bar(Have, Goal)]
							+ SVerticalBox::Slot().AutoHeight()[TextLine(Progress, TEXT("Regular"), 10, DimColor)]
						]
					]
				];
			}
			PassportBody->AddSlot()[Tasks];
			bool bAll = false;
			Today->TryGetBoolField(TEXT("all"), bAll);
			const double Days = JsonNum(Today, TEXT("fullDays"));
			Note(bAll
				? FString::Printf(TEXT("All three done today. There will be three new tasks tomorrow. Full days so far: %s."), *ShortCount(Days))
				: FString::Printf(TEXT("Each task pays %s coins, and doing all three pays %s more. Nothing runs out: tomorrow simply brings three new ones.%s"), *CoinsEach,
					*ShortCount(JsonNum(Today, TEXT("coinsAll"))), Days > 0.0 ? *FString::Printf(TEXT(" Full days so far: %s."), *ShortCount(Days)) : TEXT("")));
		}

		// ---- favours: asked by things you have talked to. They wait until they are done, or until you say never mind.
		Heading(TEXT("Favours"));
		const TArray<TSharedPtr<FJsonObject>> Favours = Rows(TEXT("favours"));
		for (const TSharedPtr<FJsonObject>& Favour : Favours)
		{
			const double Have = JsonNum(Favour, TEXT("have")), Goal = JsonNum(Favour, TEXT("goal"));
			const FString Detail = FString::Printf(TEXT("%s%s Pays %s coins."),
				JsonStr(Favour, TEXT("unit")) == TEXT("m") ? *FString::Printf(TEXT("%s of %s m. "), *ShortCount(Have), *ShortCount(Goal)) : TEXT(""),
				*JsonStr(Favour, TEXT("next")), *ShortCount(JsonNum(Favour, TEXT("coins"))));
			PassportBody->AddSlot().Padding(0.f, 0.f, 0.f, 6.f)
			[
				SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(CardColor).Padding(FMargin(10.f, 7.f))
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()[WrappedLine(JsonStr(Favour, TEXT("text")), TEXT("Bold"), 12, FLinearColor::White, 620.f)]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 5.f, 0.f, 3.f)[Bar(Have, Goal)]
						+ SVerticalBox::Slot().AutoHeight()[WrappedLine(Detail, TEXT("Regular"), 10, DimColor, 620.f)]
					]
					+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)[Button(TEXT("Never mind"), TEXT("favour"), JsonStr(Favour, TEXT("id")))]
				]
			];
		}
		const FString FavoursDone = ShortCount(JsonNum(Journal, TEXT("favoursDone")));
		Note(Favours.Num() > 0
			? FString::Printf(TEXT("A favour waits until it is done: nothing runs out. Favours done so far: %s."), *FavoursDone)
			: FString::Printf(TEXT("Nobody is waiting on a favour from you. Talk to anything (T) and ask \"can I help?\"; some ask without being asked. Favours done so far: %s."), *FavoursDone));

		// ---- the treasure hunt and the expeditions: begun here, done out in the world
		Heading(TEXT("Expeditions"));
		const auto Journey = [this](bool bActive, bool bFinished, const FString& Name, const FString& Text, const TSharedRef<SWidget>& Middle, const FString& Small, const TSharedRef<SWidget>& Act)
		{
			PassportBody->AddSlot().Padding(0.f, 0.f, 0.f, 6.f)
			[
				SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bActive ? CardDoneColor : CardColor).Padding(FMargin(10.f, 7.f))
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()[WrappedLine(Name, TEXT("Bold"), 12, bFinished ? DimColor : FLinearColor::White, 620.f)]
						+ SVerticalBox::Slot().AutoHeight()[WrappedLine(Text, TEXT("Regular"), 12, bFinished ? DimColor : FLinearColor::White, 620.f)]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f)[Middle]
						+ SVerticalBox::Slot().AutoHeight()[WrappedLine(Small, TEXT("Regular"), 10, DimColor, 620.f)]
					]
					+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(10.f, 0.f, 0.f, 0.f)[Act]
				]
			];
		};
		const TSharedPtr<FJsonObject> Hunt = Object(TEXT("hunt"));
		if (Hunt.IsValid())
		{
			const FString Way = JsonStr(Hunt, TEXT("way"));
			Journey(true, false, FString::Printf(TEXT("Treasure hunt: clue %d of %d"), FMath::RoundToInt32(JsonNum(Hunt, TEXT("at"))) + 1, FMath::RoundToInt32(JsonNum(Hunt, TEXT("of")))),
				JsonStr(Hunt, TEXT("clue")), SNullWidget::NullWidget,
				FString::Printf(TEXT("%s%s min so far, and nothing runs out. Type /clue to hear it again."), Way.IsEmpty() ? TEXT("") : *FString::Printf(TEXT("It is %s. "), *Way), *ShortCount(JsonNum(Hunt, TEXT("minutes")))),
				Button(TEXT("Give up this hunt"), TEXT("drop"), TEXT("hunt")));
		}
		else
		{
			const double Best = JsonNum(Journal, TEXT("huntBestMinutes"));
			Journey(false, false, TEXT("A treasure hunt, here"), TEXT("A handful of riddles about real places near where you are standing, with treasure at the last."), SNullWidget::NullWidget,
				FString::Printf(TEXT("Friends who start here today get the same hunt. Treasures found: %s%s."), *ShortCount(JsonNum(Journal, TEXT("huntsDone"))),
					Best > 0.0 ? *FString::Printf(TEXT(", the quickest in %s min"), *ShortCount(Best)) : TEXT("")),
				Button(TEXT("Start a treasure hunt"), TEXT("start"), TEXT("hunt")));
		}
		TArray<TSharedPtr<FJsonObject>> Expeditions = Rows(TEXT("expeditions"));
		const auto StateOrder = [](const TSharedPtr<FJsonObject>& Expedition)
		{
			const FString State = JsonStr(Expedition, TEXT("state"));
			return State == TEXT("active") ? 0 : State == TEXT("open") ? 1 : 2;
		};
		Expeditions.StableSort([&StateOrder](const TSharedPtr<FJsonObject>& A, const TSharedPtr<FJsonObject>& B) { return StateOrder(A) < StateOrder(B); });
		for (const TSharedPtr<FJsonObject>& Expedition : Expeditions)
		{
			const FString State = JsonStr(Expedition, TEXT("state")), Sort = JsonStr(Expedition, TEXT("sort")), Id = JsonStr(Expedition, TEXT("id"));
			const FString Pays = ShortCount(JsonNum(Expedition, TEXT("coins")));
			// What there is to find, each ticked off in gold as it is.
			const TSharedRef<SWrapBox> Chips = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(10.0, 2.0));
			if (Sort != TEXT("home"))
			{
				for (const TSharedPtr<FJsonObject>& Item : JsonRows(Expedition, TEXT("items")))
				{
					bool bGot = false;
					Item->TryGetBoolField(TEXT("got"), bGot);
					Chips->AddSlot()[TextLine(JsonStr(Item, TEXT("name")), TEXT("Bold"), 10, bGot ? GoldColor : FLinearColor(1.f, 1.f, 1.f, 0.4f))];
				}
			}
			const FString Small = State == TEXT("done") ? FString(TEXT("Done."))
				: State == TEXT("active") ? (Sort == TEXT("home") ? FString::Printf(TEXT("It is walking with you. Pays %s coins."), *Pays)
					: FString::Printf(TEXT("%s of %s so far. Pays %s coins."), *ShortCount(JsonNum(Expedition, TEXT("have"))), *ShortCount(JsonNum(Expedition, TEXT("need"))), *Pays))
				: FString::Printf(TEXT("Pays %s coins."), *Pays);
			Journey(State == TEXT("active"), State == TEXT("done"), JsonStr(Expedition, TEXT("title")), JsonStr(Expedition, TEXT("blurb")), Chips, Small,
				State == TEXT("open") ? Button(TEXT("Set out"), TEXT("start"), Id) : State == TEXT("active") ? Button(TEXT("Give up"), TEXT("drop"), Id) : SNullWidget::NullWidget);
		}

		// ---- the garage: my own car, its paint and its body, and a button to bring it here
		const TSharedPtr<FJsonObject> Garage = Object(TEXT("garage"));
		if (Garage.IsValid())
		{
			Heading(TEXT("Your car"));
			PassportBody->AddSlot().Padding(0.f, 0.f, 0.f, 6.f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth()[Button(TEXT("Bring my car here"), TEXT("car-call"), FString())]
				+ SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f, 0.f, 0.f)[Button(TEXT("Send it away"), TEXT("car-away"), FString())]
				+ SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center).Padding(12.f, 0.f, 0.f, 0.f)
				[
					WrappedLine(TEXT("It draws up beside you; press E next to it to get in. Typing /car brings it too. Only you can drive it, and friends can ride along."), TEXT("Regular"), 10, DimColor, 500.f)
				]
			];
			const FString PaintOn = JsonStr(Garage, TEXT("paint")), BodyOn = JsonStr(Garage, TEXT("body"));
			const auto Choices = [&](const TCHAR* Field, const TCHAR* Action, const FString& Chosen, const TCHAR* ChosenWords, bool bSwatch)
			{
				const TSharedRef<SWrapBox> Wrap = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
				for (const TSharedPtr<FJsonObject>& Choice : JsonRows(Garage, Field))
				{
					const FString Id = JsonStr(Choice, TEXT("id"));
					bool bOwned = false;
					Choice->TryGetBoolField(TEXT("owned"), bOwned);
					const double Price = JsonNum(Choice, TEXT("price"));
					const bool bOn = Chosen == Id;
					const bool bCanHave = bOwned || Coins >= Price;
					const uint32 Hex = static_cast<uint32>(JsonNum(Choice, TEXT("hex")));
					const FLinearColor Swatch = FLinearColor::FromSRGBColor(FColor((Hex >> 16) & 0xff, (Hex >> 8) & 0xff, Hex & 0xff));
					Wrap->AddSlot()
					[
						SNew(SBox).WidthOverride(188.f)
						[
							SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bOn ? CardDoneColor : CardColor).Padding(FMargin(10.f, 7.f))
							[
								SNew(SHorizontalBox)
								+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, bSwatch ? 8.f : 0.f, 0.f)
								[
									SNew(SBox).WidthOverride(bSwatch ? 22.f : 0.f).HeightOverride(22.f)
									[
										SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(Swatch).Visibility(bSwatch ? EVisibility::HitTestInvisible : EVisibility::Collapsed)
									]
								]
								+ SHorizontalBox::Slot().FillWidth(1.f)
								[
									SNew(SVerticalBox)
									+ SVerticalBox::Slot().AutoHeight()[TextLine(JsonStr(Choice, TEXT("name")), TEXT("Bold"), 12, FLinearColor::White)]
									+ SVerticalBox::Slot().AutoHeight()[TextLine(bOn ? FString(ChosenWords) : bOwned ? FString(TEXT("Yours")) : FString::Printf(TEXT("%s coins"), *ShortCount(Price)), TEXT("Regular"), 10, DimColor)]
									+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 0.f).HAlign(HAlign_Left)
									[
										bOn || !bCanHave ? SNullWidget::NullWidget : Button(bOwned ? TEXT("Choose it") : TEXT("Buy it"), Action, Id)
									]
								]
							]
						]
					];
				}
				PassportBody->AddSlot().Padding(0.f, 0.f, 0.f, 8.f)[Wrap];
			};
			Choices(TEXT("paints"), TEXT("car-paint"), PaintOn, TEXT("On your car"), true);
			Choices(TEXT("bodies"), TEXT("car-body"), BodyOn, TEXT("Yours is one"), false);
		}

		// ---- hats: bought with coins or won, one worn at a time. Friends see it on you.
		Heading(TEXT("Hats"));
		const FString Wearing = JsonStr(Journal, TEXT("hat"));
		const TSharedRef<SWrapBox> Hats = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
		const auto HatCard = [this, &Hats](bool bOn, bool bOwned, const FString& Name, const FString& Small, const TSharedRef<SWidget>& Act)
		{
			Hats->AddSlot()
			[
				SNew(SBox).WidthOverride(188.f)
				[
					SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bOn ? CardDoneColor : CardColor).Padding(FMargin(10.f, 7.f))
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()[TextLine(Name, TEXT("Bold"), 12, bOn || bOwned ? FLinearColor::White : FLinearColor(1.f, 1.f, 1.f, 0.75f))]
						+ SVerticalBox::Slot().AutoHeight()[WrappedLine(Small, TEXT("Regular"), 10, DimColor, 166.f)]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 4.f, 0.f, 0.f).HAlign(HAlign_Left)[Act]
					]
				]
			];
		};
		HatCard(Wearing.IsEmpty(), true, TEXT("No hat"), Wearing.IsEmpty() ? TEXT("As you are") : TEXT(""),
			Wearing.IsEmpty() ? SNullWidget::NullWidget : Button(TEXT("Take it off"), TEXT("hat-wear"), FString()));
		for (const TSharedPtr<FJsonObject>& Hat : Rows(TEXT("hats")))
		{
			const FString Id = JsonStr(Hat, TEXT("id"));
			if (!UEarthAnimalFigure::KnowsHat(Id))
			{
				continue; // a hat this game cannot draw yet
			}
			bool bOwned = false;
			Hat->TryGetBoolField(TEXT("owned"), bOwned);
			double Price = 0.0;
			const bool bPriced = Hat->TryGetNumberField(TEXT("price"), Price);
			const bool bOn = Wearing == Id;
			const bool bCanBuy = !bOwned && bPriced && Coins >= Price;
			const FString Small = bOn ? FString(TEXT("You are wearing it")) : bOwned ? FString(TEXT("Yours"))
				: bPriced ? FString::Printf(TEXT("%s coins"), *ShortCount(Price)) : FString::Printf(TEXT("A prize. %s"), *JsonStr(Hat, TEXT("how")));
			HatCard(bOn, bOwned, JsonStr(Hat, TEXT("name")), Small,
				bOn ? SNullWidget::NullWidget : bOwned ? Button(TEXT("Put it on"), TEXT("hat-wear"), Id) : bCanBuy ? Button(TEXT("Buy it"), TEXT("hat-buy"), Id) : SNullWidget::NullWidget);
		}
		PassportBody->AddSlot()[Hats];

		// ---- riddles: those unlocked so far, each with its answer once it is found
		const TArray<TSharedPtr<FJsonObject>> Riddles = Rows(TEXT("riddles"));
		const TSharedPtr<FJsonObject> MoreRiddles = Object(TEXT("moreRiddles"));
		if (Riddles.Num() > 0 || MoreRiddles.IsValid())
		{
			Heading(TEXT("Riddles"));
			const TSharedRef<SWrapBox> Cards = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
			for (const TSharedPtr<FJsonObject>& Riddle : Riddles)
			{
				bool bSolved = false;
				Riddle->TryGetBoolField(TEXT("solved"), bSolved);
				Cards->AddSlot()
				[
					SNew(SBox).WidthOverride(386.f)
					[
						SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bSolved ? CardDoneColor : CardColor).Padding(FMargin(10.f, 7.f))
						[
							SNew(SVerticalBox)
							+ SVerticalBox::Slot().AutoHeight()[WrappedLine(JsonStr(Riddle, TEXT("text")), TEXT("Regular"), 12, FLinearColor::White, 364.f)]
							+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 0.f)[WrappedLine(bSolved ? FString::Printf(TEXT("Solved: it was %s."), *JsonStr(Riddle, TEXT("answer")))
								: FString(TEXT("Find the answer in the world, and talk to it or ride it.")), TEXT("Regular"), 10, DimColor, 364.f)]
						]
					]
				];
			}
			PassportBody->AddSlot()[Cards];
			if (MoreRiddles.IsValid())
			{
				const double More = JsonNum(MoreRiddles, TEXT("count"));
				Note(FString::Printf(TEXT("%s more %s at level %s."), *ShortCount(More), More == 1.0 ? TEXT("riddle") : TEXT("riddles"), *ShortCount(JsonNum(MoreRiddles, TEXT("level")))));
			}
		}

		// ---- companions: the answers of solved riddles, any one of which will follow you about
		{
			Heading(TEXT("Companions"));
			TArray<FString> Won;
			const TArray<TSharedPtr<FJsonValue>>* Pets = nullptr;
			if (Journal->TryGetArrayField(TEXT("pets"), Pets))
			{
				for (const TSharedPtr<FJsonValue>& Value : *Pets)
				{
					if (Value.IsValid() && !Value->AsString().IsEmpty())
					{
						Won.Add(Value->AsString());
					}
				}
			}
			const FString With = JsonStr(Journal, TEXT("pet"));
			if (Won.Num() == 0)
			{
				Note(TEXT("Solve a riddle and its answer will keep you company."));
			}
			else
			{
				const TSharedRef<SWrapBox> Choices = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
				const auto Choice = [&](const FString& Name, const FString& Sp)
				{
					const bool bOn = With == Sp;
					Choices->AddSlot()
					[
						SNew(SBorder).BorderImage(&CardBrush).BorderBackgroundColor(bOn ? CardDoneColor : CardColor).Padding(FMargin(10.f, 6.f))
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[TextLine(Name, TEXT("Bold"), 12, FLinearColor::White)]
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(8.f, 0.f, 0.f, 0.f)
							[
								bOn ? StaticCastSharedRef<SWidget>(TextLine(TEXT("with you"), TEXT("Regular"), 10, DimColor)) : Button(TEXT("Choose"), TEXT("pet"), Sp)
							]
						]
					];
				};
				Choice(TEXT("Nobody"), FString());
				for (const FString& Sp : Won)
				{
					const TCHAR* Kind = EarthMounts::Called(Sp);
					Choice(Kind ? FString(Kind) : Sp, Sp);
				}
				PassportBody->AddSlot()[Choices];
			}
		}

		// ---- the stamps
		PassportBody->AddSlot().Padding(0.f, 0.f, 0.f, 4.f)[TextLine(TEXT("Stamps"), TEXT("Bold"), 14, FLinearColor::White)];
		const TSharedRef<SWrapBox> Stamps = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
		for (const TSharedPtr<FJsonObject>& Stamp : Rows(TEXT("stamps")))
		{
			TArray<double> Steps;
			const TArray<TSharedPtr<FJsonValue>>* StepValues = nullptr;
			if (Stamp->TryGetArrayField(TEXT("steps"), StepValues))
			{
				for (const TSharedPtr<FJsonValue>& Value : *StepValues)
				{
					Steps.Add(Value.IsValid() ? Value->AsNumber() : 0.0);
				}
			}
			const int32 Done = FMath::RoundToInt32(JsonNum(Stamp, TEXT("done")));
			const bool bSingle = Steps.Num() == 1;
			double NextAt = 0.0;
			const bool bMore = Stamp->TryGetNumberField(TEXT("next"), NextAt);
			const TSharedRef<SHorizontalBox> Pips = SNew(SHorizontalBox);
			for (int32 i = 0; !bSingle && i < Steps.Num(); ++i)
			{
				Pips->AddSlot().AutoWidth().Padding(0.f, 0.f, 8.f, 0.f)[TextLine(ShortCount(Steps[i]), TEXT("Bold"), 10, i < Done ? GoldColor : FLinearColor(1.f, 1.f, 1.f, 0.35f))];
			}
			Stamps->AddSlot()
			[
				SNew(SBox).WidthOverride(188.f)
				[
					SNew(SBorder)
					.BorderImage(&CardBrush)
					.BorderBackgroundColor(Done > 0 ? CardDoneColor : CardColor)
					.Padding(FMargin(10.f, 7.f))
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()[TextLine(JsonStr(Stamp, TEXT("title")), TEXT("Bold"), 12, FLinearColor::White)]
						+ SVerticalBox::Slot().AutoHeight()[TextLine(bSingle ? FString(Done > 0 ? TEXT("Done") : TEXT("Not yet")) : CountedIn(JsonNum(Stamp, TEXT("have")), JsonStr(Stamp, TEXT("unit"))), TEXT("Regular"), 12, FLinearColor::White)]
						+ SVerticalBox::Slot().AutoHeight()[TextLine(bSingle ? FString() : bMore ? FString::Printf(TEXT("Next stamp at %s"), *ShortCount(NextAt)) : FString(TEXT("All stamps earned")), TEXT("Regular"), 10, DimColor)]
						+ SVerticalBox::Slot().AutoHeight()[Pips]
					]
				]
			];
		}
		PassportBody->AddSlot()[Stamps];

		// ---- where, who and what
		const auto List = [](const TCHAR* Title, const TArray<TPair<FString, FString>>& Lines, const TCHAR* Empty)
		{
			const TSharedRef<SVerticalBox> Box = SNew(SVerticalBox);
			Box->AddSlot().AutoHeight().Padding(0.f, 0.f, 0.f, 2.f)[TextLine(Title, TEXT("Bold"), 13, FLinearColor::White)];
			if (Lines.Num() == 0)
			{
				Box->AddSlot().AutoHeight()[SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 11)).ColorAndOpacity(DimColor).WrapTextAt(360.f).Text(FText::FromString(Empty))];
			}
			for (const TPair<FString, FString>& Line : Lines)
			{
				Box->AddSlot().AutoHeight()
				[
					SNew(SHorizontalBox)
					+ SHorizontalBox::Slot().FillWidth(1.f)[TextLine(Line.Key, TEXT("Regular"), 12, FLinearColor::White)]
					+ SHorizontalBox::Slot().AutoWidth().Padding(8.f, 0.f, 0.f, 0.f)[TextLine(Line.Value, TEXT("Regular"), 11, DimColor)]
				];
			}
			return Box;
		};
		TArray<TPair<FString, FString>> CountryLines, PlaceLines, FriendLines, RiddenLines;
		for (const TSharedPtr<FJsonObject>& Row : Rows(TEXT("countries")))
		{
			CountryLines.Add({ JsonStr(Row, TEXT("name")), DateOf(JsonNum(Row, TEXT("first"))) });
		}
		for (const TSharedPtr<FJsonObject>& Row : Rows(TEXT("places")))
		{
			PlaceLines.Add({ JsonStr(Row, TEXT("name")), JsonStr(Row, TEXT("country")) });
		}
		for (const TSharedPtr<FJsonObject>& Row : Rows(TEXT("friends")))
		{
			const FString Sp = JsonStr(Row, TEXT("sp"));
			const TCHAR* Kind = EarthMounts::Called(Sp);
			const double Times = JsonNum(Row, TEXT("times"));
			FriendLines.Add({ FString::Printf(TEXT("%s the %s"), *JsonStr(Row, TEXT("name")), Kind ? Kind : *Sp), Times > 1.0 ? FString::Printf(TEXT("%s chats"), *ShortCount(Times)) : FString() });
		}
		const TArray<TSharedPtr<FJsonValue>>* Ridden = nullptr;
		if (Journal->TryGetArrayField(TEXT("riddenKinds"), Ridden))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Ridden)
			{
				const FString Sp = Value.IsValid() ? Value->AsString() : FString();
				const TCHAR* Kind = EarthMounts::Called(Sp);
				RiddenLines.Add({ Kind ? FString(Kind) : Sp, FString() });
			}
		}
		PassportBody->AddSlot().Padding(0.f, 14.f, 0.f, 0.f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().FillWidth(1.f).Padding(0.f, 0.f, 16.f, 0.f)[List(TEXT("Countries"), CountryLines, TEXT("Walk somewhere and it will be stamped here."))]
			+ SHorizontalBox::Slot().FillWidth(1.f)[List(TEXT("Lately"), PlaceLines, TEXT("Nowhere yet."))]
		];
		PassportBody->AddSlot().Padding(0.f, 12.f, 0.f, 0.f)
		[
			SNew(SHorizontalBox)
			+ SHorizontalBox::Slot().FillWidth(1.f).Padding(0.f, 0.f, 16.f, 0.f)[List(TEXT("Friends"), FriendLines, TEXT("Press T beside an animal, a tree or a car to make one."))]
			+ SHorizontalBox::Slot().FillWidth(1.f)[List(TEXT("Ridden"), RiddenLines, TEXT("Press E beside a horse, a car or a train."))]
		];

		bool bKept = false;
		Journal->TryGetBoolField(TEXT("kept"), bKept);
		const double Minutes = JsonNum(Totals, TEXT("minutes"));
		const FString Foot = bKept
			? FString::Printf(TEXT("Yours alone: nobody else can open your passport. Kept since %s  ·  %s visits  ·  %s in the world."), *DateOf(JsonNum(Journal, TEXT("since"))),
				*ShortCount(JsonNum(Totals, TEXT("visits"))), Minutes < 90.0 ? *FString::Printf(TEXT("%s min"), *ShortCount(Minutes)) : *FString::Printf(TEXT("%.1f h"), Minutes / 60.0))
			: FString(TEXT("You are a guest, so this passport lasts only for this visit. Type /login to sign in with Google and keep one."));
		PassportBody->AddSlot().Padding(0.f, 14.f, 0.f, 0.f)
		[
			SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 10)).ColorAndOpacity(DimColor).WrapTextAt(780.f).Text(FText::FromString(Foot))
		];
	}

	/** The header: the name of the place, and what goes beneath it. */
	void SetWhere(const FString& Name, const FString& Sub)
	{
		Where->SetVisibility(EVisibility::HitTestInvisible);
		WhereName->SetText(FText::FromString(Name));
		WhereSub->SetText(FText::FromString(Sub));
		WhereSub->SetVisibility(Sub.IsEmpty() ? EVisibility::Collapsed : EVisibility::HitTestInvisible);
	}
	/** Starts the header's flourish: it swells and flashes blue for a moment. */
	void Arrive() { ArrivedAt = FPlatformTime::Seconds(); }

	virtual void Tick(const FGeometry& AllottedGeometry, const double InCurrentTime, const float InDeltaTime) override
	{
		SCompoundWidget::Tick(AllottedGeometry, InCurrentTime, InDeltaTime);
		// The flourish: the header starts a quarter larger and settles.
		LayoutScale = AllottedGeometry.Scale > 0.f ? AllottedGeometry.Scale : 1.f;
		// Stamps just earned take their turn, one at a time.
		const double Now = FPlatformTime::Seconds();
		if (Now > ToastUntil)
		{
			if (Toasts.Num() > 0)
			{
				ToastLabel->SetText(FText::FromString(Toasts[0].Label));
				ToastTitle->SetText(FText::FromString(Toasts[0].Title));
				ToastText->SetText(FText::FromString(Toasts[0].Text));
				ToastText->SetVisibility(Toasts[0].Text.IsEmpty() ? EVisibility::Collapsed : EVisibility::HitTestInvisible);
				Toast->SetVisibility(EVisibility::HitTestInvisible);
				Toasts.RemoveAt(0);
				ToastUntil = Now + ToastSeconds;
			}
			else
			{
				Toast->SetVisibility(EVisibility::Collapsed);
			}
		}
		const float Settled = FMath::Clamp(Arrived(), 0.f, 1.f);
		const float Scale = 1.f + 0.25f * (1.f - Settled) * (1.f - Settled);
		Where->SetRenderTransform(Scale > 1.001f ? TOptional<FSlateRenderTransform>(FSlateRenderTransform(Scale)) : TOptional<FSlateRenderTransform>());
	}

	/** The credit line names whoever's data is on screen. In the photographic world the Cesium plugin adds Google's logo and per-tile credits itself. */
	static FString CreditText(bool bPhotoWorld)
	{
		// Printf checks its format at compile time, so each one has to be a literal of its own.
		return bPhotoWorld
			? FString::Printf(TEXT("EarthWalk %s  ·  3D imagery © Google  ·  Place search © OpenStreetMap contributors"), *GameVersion())
			: FString::Printf(TEXT("EarthWalk %s  ·  Map data © OpenStreetMap contributors"), *GameVersion());
	}
	/** bGoogleLine: the plugin is drawing Google's own credit line, which can start before the tiles are shown. */
	void SetCredit(bool bPhotoWorld, bool bGoogleLine)
	{
		bPhotoCredit = bGoogleLine;
		Credit->SetText(FText::FromString(CreditText(bPhotoWorld)));
	}
	TSharedPtr<SEditableTextBox> GetInput() const { return Input; }

	/** While the chat is closed the overlay ignores the pointer, so a stray click cannot steal the keyboard. */
	void SetHitTestable(bool bHitTestable)
	{
		bChatInteractive = bHitTestable;
		ApplyInteractive();
	}
	void ApplyInteractive()
	{
		SetVisibility(bChatInteractive || bPassportInteractive || bShowsInteractive ? EVisibility::Visible : EVisibility::HitTestInvisible);
		ChatColumn->SetVisibility(bChatInteractive ? EVisibility::Visible : EVisibility::HitTestInvisible);
	}

private:
	void HandleCommitted(const FText& Text, ETextCommit::Type How)
	{
		AEarthWalkHUD* Hud = Owner.Get();
		if (!Hud)
		{
			return;
		}
		if (How == ETextCommit::OnEnter)
		{
			const FString Typed = Text.ToString().TrimStartAndEnd();
			Input->SetText(FText::GetEmpty());
			if (!Typed.IsEmpty())
			{
				Hud->Submit(Typed);
			}
		}
		Hud->CloseChat();
	}

	/** 0 at the moment of arriving somewhere new, 1 once the flourish is over. */
	float Arrived() const { return ArrivedAt > 0.0 ? static_cast<float>((FPlatformTime::Seconds() - ArrivedAt) / ArrivedSeconds) : 1.f; }

	TWeakObjectPtr<AEarthWalkHUD> Owner;
	FSlateRoundedBoxBrush WhereBrush = FSlateRoundedBoxBrush(FLinearColor::White, 12.f);
	TSharedPtr<SBorder> Where;
	TSharedPtr<STextBlock> WhereName;
	TSharedPtr<STextBlock> WhereSub;
	double ArrivedAt = 0.0;
	TSharedPtr<STextBlock> Status;
	TSharedPtr<STextBlock> Credit;
	bool bPhotoCredit = false;
	TSharedPtr<SScrollBox> Log;
	TSharedPtr<SEditableTextBox> Input;
	TArray<TSharedRef<SWidget>> Lines;

	TSharedPtr<STextBlock> Hint;
	TSharedPtr<SBorder> RacePanel;
	TSharedPtr<STextBlock> RaceText;
	TSharedPtr<STextBlock> RaceCount;
	FString RaceShown;
	FString CountShown;
	struct FShownBubble
	{
		uint32 Thing = 0;
		double Until = 0.0;
		FVector Where = FVector::ZeroVector;
		TSharedPtr<SWidget> Widget;
		TSharedPtr<FVector2D> At; // where on screen, for the canvas to read
	};
	TArray<FShownBubble> Shown;
	TSharedPtr<SCanvas> BubbleCanvas;
	FSlateRoundedBoxBrush BubbleBrush = FSlateRoundedBoxBrush(BubblePaper, 14.f, BubbleInk, 2.5f);
	float LayoutScale = 1.f;

	struct FToast
	{
		FString Label;
		FString Title;
		FString Text;
	};
	TArray<FToast> Toasts;
	double ToastUntil = 0.0;
	TSharedPtr<SBorder> Toast;
	TSharedPtr<STextBlock> ToastLabel;
	TSharedPtr<STextBlock> ToastTitle;
	TSharedPtr<STextBlock> ToastText;
	FSlateRoundedBoxBrush ToastBrush = FSlateRoundedBoxBrush(BubblePaper, 14.f, GoldColor, 3.f);

	TSharedPtr<SBorder> Passport;
	TSharedPtr<SScrollBox> PassportBody;
	TSharedPtr<FJsonObject> LastJournal;
	TSharedPtr<SBorder> ShowsPanel;
	TSharedPtr<SScrollBox> ShowsBody;
	bool bShowsInteractive = false;
	// A thing to show: a card that lights up under the pointer.
	FButtonStyle ShowButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 20)), 8.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f));
	TSharedPtr<SBox> ChatColumn;
	bool bChatInteractive = false;
	bool bPassportInteractive = false;
	FSlateRoundedBoxBrush CardBrush = FSlateRoundedBoxBrush(FLinearColor::White, 8.f);
};

void AEarthWalkHUD::BeginPlay()
{
	Super::BeginPlay();

	if (GEngine && GEngine->GameViewport)
	{
		SAssignNew(Overlay, SEarthWalkOverlay, this);
		Overlay->SetHitTestable(false);
		GEngine->GameViewport->AddViewportWidgetContent(Overlay.ToSharedRef(), 10);
		// The menu, the box that asks "where to?" and the strip of buttons, over everything else.
		SAssignNew(Menu, SEarthMenu, this);
		FString Buttons;
		bStripOn = !(FEarthWalkConfig::HasOverride(TEXT("Buttons"), Buttons) && Buttons.Equals(TEXT("off"), ESearchCase::IgnoreCase));
		Menu->ShowStrip(bStripOn);
		GEngine->GameViewport->AddViewportWidgetContent(Menu.ToSharedRef(), 11);
	}
	// Tab is the menu. It is bound, not just looked at each frame, so that it is used up here: left to
	// itself Tab moves the keyboard from one thing on the screen to the next, as it does in any window.
	if (APlayerController* MenuPC = GetOwningPlayerController())
	{
		EnableInput(MenuPC);
		if (InputComponent)
		{
			InputComponent->BindKey(EKeys::Tab, IE_Pressed, this, &AEarthWalkHUD::ToggleMenu);
		}
	}

	if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
	{
		ChatHandle = Net->OnChat.AddWeakLambda(this, [this](const FString& Name, const FString& Text)
		{
			AddLine(FString::Printf(TEXT("%s: %s"), *Name, *Text));
		});
		NoticeHandle = Net->OnNotice.AddWeakLambda(this, [this](const FString& Text)
		{
			AddLine(Text, NoticeColor);
		});
		JournalHandle = Net->OnJournal.AddWeakLambda(this, [this](const TSharedPtr<FJsonObject>& Journal)
		{
			if (bPassportOpen && Overlay.IsValid())
			{
				Overlay->SetPassport(Journal);
			}
			if (bCluePending)
			{
				// "/clue" asked: read out the clue of the treasure hunt I am on.
				bCluePending = false;
				const TSharedPtr<FJsonObject>* Hunt = nullptr;
				if (Journal.IsValid() && Journal->TryGetObjectField(TEXT("hunt"), Hunt))
				{
					const FString Way = JsonStr(*Hunt, TEXT("way"));
					AddLine(FString::Printf(TEXT("Clue %d of %d: %s%s"), FMath::RoundToInt32(JsonNum(*Hunt, TEXT("at"))) + 1, FMath::RoundToInt32(JsonNum(*Hunt, TEXT("of"))),
						*JsonStr(*Hunt, TEXT("clue")), Way.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" It is %s."), *Way)), NoticeColor);
				}
				else
				{
					AddLine(TEXT("You are not on a treasure hunt. Start one from your passport (P)."), NoticeColor);
				}
			}
		});
		StampHandle = Net->OnStamp.AddWeakLambda(this, [this](const FString& Kind, const FString& Title, const FString& Text)
		{
			AddLine(FString::Printf(TEXT("%s: %s. %s"), NewsLabel(Kind), *Title, *Text), ThingColor);
			if (Overlay.IsValid())
			{
				Overlay->QueueToast(Kind, Title, Text);
			}
			if (bPassportOpen)
			{
				if (UEarthWalkNet* Room = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
				{
					Room->RequestJournal();
				}
			}
		});
		Net->OnHat.AddWeakLambda(this, [this](const FString& MemberId, const FString&)
		{
			// My own hat: put it on my figure (other people's go on theirs in AEarthWorld).
			const UEarthWalkNet* Room = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
			APlayerController* PC = GetOwningPlayerController();
			AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
			if (Room && Character && MemberId == Room->GetMyId())
			{
				Character->RefreshFigure();
			}
		});
		WelcomeHandle = Net->OnWelcome.AddWeakLambda(this, [this]()
		{
			// A signed-in player's animal comes from the account; show it.
			APlayerController* PC = GetOwningPlayerController();
			if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
			{
				Character->RefreshFigure();
			}
			// Back in the room (as another animal, perhaps): an open passport is drawn again from what the server now has.
			UEarthWalkNet* Room = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
			if (Room && bPassportOpen)
			{
				Room->RequestJournal();
			}
		});
	}

	ApplyGameInputMode(GetOwningPlayerController());
	StartedAt = FPlatformTime::Seconds();
	AddLine(TEXT("Welcome to EarthWalk. WASD to move, drag or arrow keys to look, 2 to run, V for camera view, F to fly."), NoticeColor);
	AddLine(TEXT("Press Tab to see everything you can do: go to a place, call your car or a taxi, open your passport. The buttons along the bottom do the same."), NoticeColor);
	AddLine(TEXT("Walk up to an animal, a car or a train: E hops on, T talks to it (trees and houses too)."), NoticeColor);
}

void AEarthWalkHUD::ApplyGameInputMode(APlayerController* PC)
{
	if (!PC)
	{
		return;
	}
	// Game-and-UI mode captures the mouse only while a button is down, which is what makes
	// click-drag looking work; game-only mode would capture it permanently.
	FInputModeGameAndUI Mode;
	Mode.SetHideCursorDuringCapture(true);
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::LockOnCapture);
	PC->SetInputMode(Mode);
	PC->bShowMouseCursor = true;
	if (FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().SetAllUserFocusToGameViewport();
	}
}

void AEarthWalkHUD::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
	{
		Net->OnChat.Remove(ChatHandle);
		Net->OnNotice.Remove(NoticeHandle);
		Net->OnWelcome.Remove(WelcomeHandle);
		Net->OnJournal.Remove(JournalHandle);
		Net->OnStamp.Remove(StampHandle);
	}
	if (Overlay.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(Overlay.ToSharedRef());
	}
	Overlay.Reset();
	if (Menu.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(Menu.ToSharedRef());
	}
	Menu.Reset();
	Super::EndPlay(EndPlayReason);
}

void AEarthWalkHUD::AddLine(const FString& Text, const FLinearColor& Color)
{
	if (Overlay.IsValid())
	{
		Overlay->AddLine(Text, Color);
	}
}

void AEarthWalkHUD::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	APlayerController* PC = GetOwningPlayerController();
	if (!PC || !Overlay.IsValid())
	{
		return;
	}
	if (!Typing() && FPlatformTime::Seconds() - ChatClosedAt > 0.2 && PC->WasInputKeyJustPressed(EKeys::Enter))
	{
		CloseMenu();
		OpenChat();
	}
	// The menu: Esc puts it away (and is then not "leave the game?"), and so does any key that does
	// something of its own, which it then goes on to do. Z turns the strip of buttons off and on
	// (not H or B: those are the house and the lunch box in the browser game, and will be here).
	bMenuTookEsc = false;
	if (bAskOpen && Menu.IsValid() && FSlateApplication::IsInitialized())
	{
		// The box that asks keeps the keyboard until it is answered or Esc sends it away, wherever the pointer clicks.
		if (PC->WasInputKeyJustPressed(EKeys::Escape))
		{
			AskDone(FString());
			bMenuTookEsc = true;
		}
		else if (FSlateApplication::Get().IsActive() && !Menu->GetAskInput()->HasKeyboardFocus())
		{
			FSlateApplication::Get().SetKeyboardFocus(Menu->GetAskInput(), EFocusCause::SetDirectly);
		}
	}
	if (!Typing())
	{
		if (bMenuOpen && PC->WasInputKeyJustPressed(EKeys::Escape))
		{
			CloseMenu();
			bMenuTookEsc = true;
		}
		else if (bMenuOpen && (PC->WasInputKeyJustPressed(EKeys::E) || PC->WasInputKeyJustPressed(EKeys::T) || PC->WasInputKeyJustPressed(EKeys::R)
			|| PC->WasInputKeyJustPressed(EKeys::G) || PC->WasInputKeyJustPressed(EKeys::P)))
		{
			CloseMenu();
		}
		if (PC->WasInputKeyJustPressed(EKeys::Z))
		{
			ToggleStrip();
		}
	}
	// -EWAsk=<words_with_underscores> answers the box that asks "where to?" three seconds after it comes up, as if typed, for tests.
	if (bAskOpen && AskOpenedAt > 0.0 && FPlatformTime::Seconds() - AskOpenedAt > 3.0)
	{
		AskOpenedAt = 0.0;
		FString Answer;
		if (FParse::Value(FCommandLine::Get(), TEXT("-EWAsk="), Answer))
		{
			AskDone(Answer.Replace(TEXT("_"), TEXT(" ")));
		}
	}
	// -EWMenu opens the menu by itself a few seconds in, for pictures.
	if (!bMenuTested && FPlatformTime::Seconds() - StartedAt > 11.0)
	{
		bMenuTested = true;
		if (FParse::Param(FCommandLine::Get(), TEXT("EWMenu")))
		{
			OpenMenu();
		}
	}
	UpdateCompany(PC);

	StatusTimer -= DeltaSeconds;
	if (StatusTimer <= 0.f)
	{
		StatusTimer = 0.5f;
		Overlay->SetStatus(StatusText());
		const AEarthWorld* CreditWorld = AEarthWorld::Get(this);
		Overlay->SetCredit(CreditWorld && CreditWorld->IsShowingPhoto(), CreditWorld && CreditWorld->IsPhotoCreditOnScreen());
		UpdateWhere();
	}
	if (WhereAskAt > 0.0 && FPlatformTime::Seconds() >= WhereAskAt)
	{
		WhereAskAt = 0.0;
		LookUpWhere(WhereKey, WhereLat, WhereLon);
	}

	// A signed-in player's home wins over wherever this device started, once per launch.
	UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	double HomeLat = 0.0, HomeLon = 0.0;
	FString HomeName;
	if (Net && Net->TakePendingHome(HomeLat, HomeLon, HomeName))
	{
		const AEarthWorld* Earth = AEarthWorld::Get(this);
		AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn());
		if (Earth && Character)
		{
			double Lat, Lon, Alt;
			Earth->WorldToGeo(Character->GetActorLocation(), Lat, Lon, Alt);
			if (FMath::Abs(Lat - HomeLat) > 0.001 || FMath::Abs(Lon - HomeLon) > 0.001)
			{
				AddLine(FString::Printf(TEXT("Taking you home: %s"), *HomeName), NoticeColor);
				Character->TeleportToGeo(HomeLat, HomeLon);
			}
		}
	}
}

UEarthCompany* AEarthWalkHUD::Company() const
{
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	return Earth ? Earth->GetCompany() : nullptr;
}

void AEarthWalkHUD::UpdateCompany(APlayerController* PC)
{
	UEarthCompany* Friends = Company();
	if (!Friends)
	{
		return;
	}
	if (!bCompanyBound)
	{
		bCompanyBound = true;
		// What somebody asked a thing, and what it answered, go in the log as well as in its bubble.
		Friends->OnLine.AddWeakLambda(this, [this](const FString& Who, const FString& Text, bool bFromThing)
		{
			AddLine(FString::Printf(TEXT("%s: %s"), *Who, *Text), bFromThing ? ThingColor : FLinearColor::White);
		});
		// Where "Show me" is taking the player, and what to press there.
		const AEarthWorld* ShowWorld = AEarthWorld::Get(this);
		if (UEarthShowcase* Showcase = ShowWorld ? ShowWorld->GetShowcase() : nullptr)
		{
			Showcase->OnLine.AddWeakLambda(this, [this](const FString& Text, bool bProblem)
			{
				AddLine(Text, bProblem ? ErrorColor : NoticeColor);
			});
		}
	}
	if (!Typing() && bShowsOpen)
	{
		// The list of things to show is up: a number picks one, G or Esc puts it away, and nothing else is listening.
		static const FKey Row[10] = { EKeys::One, EKeys::Two, EKeys::Three, EKeys::Four, EKeys::Five, EKeys::Six, EKeys::Seven, EKeys::Eight, EKeys::Nine, EKeys::Zero };
		static const FKey Pad[10] = { EKeys::NumPadOne, EKeys::NumPadTwo, EKeys::NumPadThree, EKeys::NumPadFour, EKeys::NumPadFive, EKeys::NumPadSix, EKeys::NumPadSeven, EKeys::NumPadEight, EKeys::NumPadNine, EKeys::NumPadZero };
		const AEarthWorld* ShowWorld = AEarthWorld::Get(this);
		const UEarthShowcase* Showcase = ShowWorld ? ShowWorld->GetShowcase() : nullptr;
		for (int32 i = 0; i < 10 && bShowsOpen && Showcase; ++i)
		{
			if ((PC->WasInputKeyJustPressed(Row[i]) || PC->WasInputKeyJustPressed(Pad[i])) && Showcase->GetShows().IsValidIndex(i))
			{
				const FString Picked = Showcase->GetShows()[i].Id;
				ShowChosen(Picked);
			}
		}
		if (bShowsOpen && (PC->WasInputKeyJustPressed(EKeys::G) || PC->WasInputKeyJustPressed(EKeys::Escape)))
		{
			CloseShows();
		}
	}
	else if (!Typing())
	{
		if (PC->WasInputKeyJustPressed(EKeys::E))
		{
			Friends->KeyRide(); // hop on whatever is nearest, or hop off
		}
		else if (PC->WasInputKeyJustPressed(EKeys::T))
		{
			if (Friends->KeyTalk())
			{
				Overlay->SetInputHint(FString::Printf(TEXT("Say something to %s..."), *Friends->TalkingTo()));
				OpenChat(); // say hello, then type
			}
		}
		else if (PC->WasInputKeyJustPressed(EKeys::R))
		{
			Friends->KeyRace(); // set a race up, join one, or (if it is mine) start it
		}
		else if (PC->WasInputKeyJustPressed(EKeys::G))
		{
			ToggleShows(); // things to show somebody, and straight to the one picked
		}
		else if (PC->WasInputKeyJustPressed(EKeys::P))
		{
			TogglePassport(); // where I have been and what I have done
		}
		else if (PC->WasInputKeyJustPressed(EKeys::Escape) && !bMenuTookEsc)
		{
			if (bPassportOpen || Friends->IsTalking())
			{
				ClosePassport();
				Friends->StopTalking(); // and stop talking to whatever it was
			}
			else if (FPlatformTime::Seconds() - QuitAskedAt < 5.0)
			{
				// The game fills the screen, with no window to close: Esc, and Esc again, is the way out.
				UKismetSystemLibrary::QuitGame(this, PC, EQuitPreference::Quit, false);
			}
			else
			{
				QuitAskedAt = FPlatformTime::Seconds();
				AddLine(TEXT("Leave EarthWalk? Press Esc again to quit. Any other key and you stay."), NoticeColor);
			}
		}
		if (bPassportOpen)
		{
			const float Scroll = (PC->WasInputKeyJustPressed(EKeys::PageDown) || PC->WasInputKeyJustPressed(EKeys::MouseScrollDown) ? 160.f : 0.f)
				- (PC->WasInputKeyJustPressed(EKeys::PageUp) || PC->WasInputKeyJustPressed(EKeys::MouseScrollUp) ? 160.f : 0.f);
			if (Scroll != 0.f)
			{
				Overlay->ScrollPassport(Scroll);
			}
		}
	}
	// What is typed goes to the thing being talked to, and the box says so.
	const FString TalkingTo = Friends->IsTalking() ? Friends->TalkingTo() : FString();
	if (TalkingTo != TalkingToShown)
	{
		TalkingToShown = TalkingTo;
		Overlay->SetInputHint(TalkingTo.IsEmpty() ? FString(TEXT("Press Enter to chat. Tab shows everything you can do. Esc twice to quit.")) : FString::Printf(TEXT("Say something to %s..."), *TalkingTo));
	}
	Overlay->SetHint(Friends->GetHint());
	Overlay->SetRace(Friends->GetRacePanel(), Friends->GetRaceCount());
	Overlay->SetBubbles(Friends->GetBubbles(), PC);

	// The passport's buttons are pressed with the mouse; the keyboard has to stay with the game, so that
	// P and Esc still close it. If a click has left the keyboard somewhere else, give it back.
	if ((bPassportOpen || bShowsOpen) && !Typing() && FSlateApplication::IsInitialized() && GEngine && GEngine->GameViewport)
	{
		const TSharedPtr<SWidget> Focused = FSlateApplication::Get().GetUserFocusedWidget(0);
		const TSharedPtr<SWidget> Viewport = GEngine->GameViewport->GetGameViewportWidget();
		if (Focused != Viewport)
		{
			FSlateApplication::Get().SetAllUserFocusToGameViewport();
		}
	}

	// -EWPassportDo=<what>:<id> presses one of the passport's buttons by itself (start:hunt, hat-wear:cap...), for tests.
	static bool bDidAction = false;
	FString Do;
	if (!bDidAction && FPlatformTime::Seconds() - StartedAt > 9.0 && FParse::Value(FCommandLine::Get(), TEXT("-EWPassportDo="), Do))
	{
		const UEarthWalkNet* Room = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
		FString What, Id;
		if (Room && Room->IsConnected())
		{
			bDidAction = true;
			if (!Do.Split(TEXT(":"), &What, &Id))
			{
				What = Do;
			}
			PassportAction(What, Id);
		}
	}

	// -EWPassportScroll=<distance> scrolls the open passport that far down, for pictures of its lower pages.
	static bool bDidScroll = false;
	float ScrollBy = 0.f;
	if (!bDidScroll && bPassportOpen && FPlatformTime::Seconds() - StartedAt > 14.0 && FParse::Value(FCommandLine::Get(), TEXT("-EWPassportScroll="), ScrollBy))
	{
		bDidScroll = true;
		Overlay->ScrollPassport(ScrollBy);
	}

	// -EWShow=<id or words> goes to one of the things to show by itself, and -EWShowList opens the list, for pictures and tests.
	static bool bDidShow = false;
	FString ShowWhat;
	if (!bDidShow && FPlatformTime::Seconds() - StartedAt > 9.0 && FParse::Value(FCommandLine::Get(), TEXT("-EWShow="), ShowWhat))
	{
		const AEarthWalkCharacter* Walker = Cast<AEarthWalkCharacter>(PC->GetPawn());
		const AEarthWorld* ShowWorld = AEarthWorld::Get(this);
		UEarthShowcase* Showcase = ShowWorld ? ShowWorld->GetShowcase() : nullptr;
		if (Showcase && Walker && !Walker->IsWaitingForGround())
		{
			bDidShow = true;
			Showcase->Go(ShowWhat.Replace(TEXT("_"), TEXT(" ")));
		}
	}
	if (!bShowsTested && FPlatformTime::Seconds() - StartedAt > 12.0)
	{
		bShowsTested = true;
		if (FParse::Param(FCommandLine::Get(), TEXT("EWShowList")))
		{
			ToggleShows();
		}
	}

	// -EWRun=<command_with_underscores> runs one chat command by itself a few seconds in (look_flat, quit...), for tests.
	FString Run;
	if (!bRunTested && FPlatformTime::Seconds() - StartedAt > 12.0)
	{
		bRunTested = true;
		if (FParse::Value(FCommandLine::Get(), TEXT("-EWRun="), Run))
		{
			FString Command, Argument;
			if (!Run.Split(TEXT("_"), &Command, &Argument))
			{
				Command = Run;
			}
			RunCommand(Command.ToLower(), Argument.Replace(TEXT("_"), TEXT(" ")));
		}
	}

	// -EWPassport opens the passport by itself a few seconds in, for pictures.
	if (!bPassportTested && FPlatformTime::Seconds() - StartedAt > 12.0)
	{
		bPassportTested = true;
		if (FParse::Param(FCommandLine::Get(), TEXT("EWPassport")))
		{
			TogglePassport();
		}
	}
}

void AEarthWalkHUD::PassportAction(const FString& What, const FString& Id)
{
	if (What == TEXT("animal"))
	{
		// Becoming another animal is a quick leaving and coming back; the page is drawn again once we are back in.
		BecomeAnimal(Id);
		if (FSlateApplication::IsInitialized())
		{
			FSlateApplication::Get().SetAllUserFocusToGameViewport();
		}
		return;
	}
	UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net)
	{
		return;
	}
	if (What == TEXT("hat-buy"))
	{
		Net->SendHatBuy(Id);
	}
	else if (What == TEXT("hat-wear"))
	{
		Net->SendHatWear(Id);
	}
	else if (What == TEXT("start") || What == TEXT("drop"))
	{
		Net->SendExpedition(Id, What == TEXT("start"));
	}
	else if (What == TEXT("favour"))
	{
		Net->SendFavourDrop(Id);
	}
	else if (What == TEXT("car-call") || What == TEXT("car-away"))
	{
		if (UEarthCompany* Friends = Company())
		{
			Friends->CallCar(What == TEXT("car-away"));
		}
	}
	else if (What == TEXT("pet"))
	{
		Net->SendPet(Id);
	}
	else if (What == TEXT("car-paint") || What == TEXT("car-body"))
	{
		Net->SendGarage(What == TEXT("car-paint") ? TEXT("paint") : TEXT("body"), Id);
	}
	Net->RequestJournal(); // the page is drawn again from what the server now has
	if (FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().SetAllUserFocusToGameViewport();
	}
}

void AEarthWalkHUD::TogglePassport()
{
	if (bPassportOpen)
	{
		ClosePassport();
		return;
	}
	UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net || !Net->IsConnected() || !Overlay.IsValid())
	{
		AddLine(TEXT("Not connected to the meetup server, so there is no passport to open yet."), ErrorColor);
		return;
	}
	bPassportOpen = true;
	Overlay->ShowPassport(true);
	Net->RequestJournal();
}

void AEarthWalkHUD::ClosePassport()
{
	bPassportOpen = false;
	if (Overlay.IsValid())
	{
		Overlay->ShowPassport(false);
	}
}

void AEarthWalkHUD::ToggleShows()
{
	if (bShowsOpen)
	{
		CloseShows();
		return;
	}
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	UEarthShowcase* Showcase = Earth ? Earth->GetShowcase() : nullptr;
	if (!Showcase || !Overlay.IsValid())
	{
		return;
	}
	ClosePassport();
	bShowsOpen = true;
	// While the list is up the number keys choose from it, so they must not also set the player running.
	APlayerController* PC = GetOwningPlayerController();
	if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
	{
		Character->bTyping = true;
	}
	Overlay->ShowShows(true, TEXT("Looking for things to show..."));
	const TWeakObjectPtr<AEarthWalkHUD> Weak(this);
	const TWeakObjectPtr<UEarthShowcase> WeakShows(Showcase);
	Showcase->Load([Weak, WeakShows](bool bOk)
	{
		AEarthWalkHUD* Self = Weak.Get();
		const UEarthShowcase* Shows = WeakShows.Get();
		if (!Self || !Shows || !Self->bShowsOpen || !Self->Overlay.IsValid())
		{
			return;
		}
		if (bOk)
		{
			Self->Overlay->SetShows(Shows->GetShows());
		}
		else
		{
			Self->Overlay->ShowShows(true, TEXT("The world server is not answering just now. Press G to close this, and G again to try once more."));
		}
	});
}

void AEarthWalkHUD::CloseShows()
{
	if (!bShowsOpen)
	{
		return;
	}
	bShowsOpen = false;
	if (Overlay.IsValid())
	{
		Overlay->ShowShows(false);
	}
	APlayerController* PC = GetOwningPlayerController();
	if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
	{
		Character->bTyping = bChatOpen;
	}
}

void AEarthWalkHUD::ShowChosen(const FString& Id)
{
	const FString Picked = Id; // the card that was clicked goes away with the list
	CloseShows();
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	if (UEarthShowcase* Showcase = Earth ? Earth->GetShowcase() : nullptr)
	{
		Showcase->Go(Picked);
	}
	if (FSlateApplication::IsInitialized())
	{
		FSlateApplication::Get().SetAllUserFocusToGameViewport();
	}
}

void AEarthWalkHUD::BecomeAnimal(const FString& Animal)
{
	static const TCHAR* Six[] = { TEXT("fox"), TEXT("bear"), TEXT("rabbit"), TEXT("cat"), TEXT("owl"), TEXT("frog") };
	const FString Id = Animal.TrimStartAndEnd().ToLower();
	bool bKnown = false;
	for (const TCHAR* One : Six)
	{
		bKnown = bKnown || Id == One;
	}
	if (!bKnown)
	{
		AddLine(TEXT("Pick one of: fox, bear, rabbit, cat, owl, frog. Like this: /animal bear (or choose one in your passport, P)."), ErrorColor);
		return;
	}
	if (Id == FEarthWalkConfig::Avatar())
	{
		AddLine(FString::Printf(TEXT("You are %s %s already."), Id == TEXT("owl") ? TEXT("an") : TEXT("a"), *Id), NoticeColor);
		return;
	}
	if (UEarthCompany* Friends = Company())
	{
		Friends->HopOff(); // step down first: the change is a quick leaving and coming back
	}
	FEarthWalkConfig::Save(TEXT("Avatar"), Id);
	AddLine(FString::Printf(TEXT("You are %s %s now."), Id == TEXT("owl") ? TEXT("an") : TEXT("a"), *Id), NoticeColor);
	if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
	{
		Net->Connect();
	}
	APlayerController* PC = GetOwningPlayerController();
	if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
	{
		Character->RefreshFigure();
	}
	if (bPassportOpen && Overlay.IsValid())
	{
		Overlay->RedrawPassport();
	}
}

void AEarthWalkHUD::OpenChat()
{
	APlayerController* PC = GetOwningPlayerController();
	if (!PC || !Overlay.IsValid())
	{
		return;
	}
	CloseShows(); // the list and the chat box both want the number keys
	bChatOpen = true;
	if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
	{
		Character->bTyping = true;
	}
	Overlay->SetHitTestable(true);
	FInputModeGameAndUI Mode;
	Mode.SetWidgetToFocus(Overlay->GetInput());
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
	PC->SetInputMode(Mode);
	PC->bShowMouseCursor = true;
	FSlateApplication::Get().SetKeyboardFocus(Overlay->GetInput(), EFocusCause::SetDirectly);
}

void AEarthWalkHUD::CloseChat()
{
	if (!bChatOpen)
	{
		return;
	}
	bChatOpen = false;
	ChatClosedAt = FPlatformTime::Seconds();
	if (Overlay.IsValid())
	{
		Overlay->SetHitTestable(false);
	}
	if (APlayerController* PC = GetOwningPlayerController())
	{
		if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
		{
			Character->bTyping = bShowsOpen; // "/show" has just put the list up: the number keys are its own
		}
		ApplyGameInputMode(PC);
	}
}

void AEarthWalkHUD::ToggleMenu()
{
	if (Typing())
	{
		return;
	}
	if (bMenuOpen)
	{
		CloseMenu();
	}
	else
	{
		OpenMenu();
	}
}

void AEarthWalkHUD::OpenMenu()
{
	if (!Menu.IsValid() || bMenuOpen)
	{
		return;
	}
	CloseShows();
	ClosePassport();
	bMenuOpen = true;
	Menu->ShowMenu(true);
}

void AEarthWalkHUD::CloseMenu()
{
	if (bMenuOpen && Menu.IsValid())
	{
		bMenuOpen = false;
		Menu->ShowMenu(false);
	}
}

void AEarthWalkHUD::ToggleStrip()
{
	bStripOn = !bStripOn;
	if (Menu.IsValid())
	{
		Menu->ShowStrip(bStripOn);
	}
	FEarthWalkConfig::Save(TEXT("Buttons"), bStripOn ? TEXT("on") : TEXT("off"));
	AddLine(bStripOn ? TEXT("The buttons are back. Z hides them.") : TEXT("The buttons are hidden. Z brings them back, and Tab still shows everything you can do."), NoticeColor);
}

void AEarthWalkHUD::MenuAction(const FString& Id)
{
	const FEarthAction* Action = EarthMenu::Find(Id);
	if (!Action)
	{
		AddLine(FString::Printf(TEXT("There is nothing called \"%s\" to do. Tab shows everything there is."), *Id), ErrorColor);
		return;
	}
	CloseMenu();
	if (FSlateApplication::IsInitialized() && !Typing())
	{
		FSlateApplication::Get().SetAllUserFocusToGameViewport(); // a click on a button must not keep the keyboard
	}
	if (Action->Ask[0])
	{
		OpenAsk(Id);
		return;
	}
	UEarthCompany* Friends = Company();
	if (Id == TEXT("ride"))
	{
		if (Friends)
		{
			Friends->KeyRide();
		}
	}
	else if (Id == TEXT("talk"))
	{
		if (Friends && Friends->KeyTalk() && Overlay.IsValid())
		{
			Overlay->SetInputHint(FString::Printf(TEXT("Say something to %s..."), *Friends->TalkingTo()));
			OpenChat();
		}
	}
	else if (Id == TEXT("race"))
	{
		if (Friends)
		{
			Friends->KeyRace();
		}
	}
	else if (Id == TEXT("shows"))
	{
		ToggleShows();
	}
	else if (Id == TEXT("passport"))
	{
		TogglePassport();
	}
	else if (Id == TEXT("chat"))
	{
		OpenChat();
	}
	else if (Id == TEXT("strip"))
	{
		ToggleStrip();
	}
	else if (Id == TEXT("look"))
	{
		RunCommand(TEXT("look"), EarthLook::Current() == EEarthLook::Flat ? TEXT("barnyard") : TEXT("flat"));
	}
	else if (Id == TEXT("sound"))
	{
		const AEarthWorld* Earth = AEarthWorld::Get(this);
		const UEarthSounds* Sounds = Earth && Earth->GetLife() ? Earth->GetLife()->GetSounds() : nullptr;
		RunCommand(TEXT("sound"), Sounds && Sounds->IsEnabled() ? TEXT("off") : TEXT("on"));
	}
	else
	{
		// Everything else is a command by another name.
		FString Command = Action->Command, Argument;
		if (!Command.Split(TEXT(" "), &Command, &Argument))
		{
			Command = Action->Command;
		}
		RunCommand(Command, Argument);
	}
}

void AEarthWalkHUD::OpenAsk(const FString& Id)
{
	APlayerController* PC = GetOwningPlayerController();
	const FEarthAction* Action = EarthMenu::Find(Id);
	if (!PC || !Menu.IsValid() || !Action)
	{
		return;
	}
	CloseShows();
	ClosePassport();
	bAskOpen = true;
	AskOpenedAt = FPlatformTime::Seconds();
	AskAction = Id;
	if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
	{
		Character->bTyping = true;
	}
	Menu->ShowAsk(Action);
	FInputModeGameAndUI Mode;
	Mode.SetWidgetToFocus(Menu->GetAskInput());
	Mode.SetLockMouseToViewportBehavior(EMouseLockMode::DoNotLock);
	PC->SetInputMode(Mode);
	PC->bShowMouseCursor = true;
	FSlateApplication::Get().SetKeyboardFocus(Menu->GetAskInput(), EFocusCause::SetDirectly);
}

void AEarthWalkHUD::AskDone(const FString& Typed)
{
	if (!bAskOpen)
	{
		return;
	}
	const FString Id = AskAction;
	bAskOpen = false;
	AskAction.Reset();
	ChatClosedAt = FPlatformTime::Seconds(); // the Enter that answered is not also "open the chat"
	if (Menu.IsValid())
	{
		Menu->ShowAsk(nullptr);
	}
	if (APlayerController* PC = GetOwningPlayerController())
	{
		if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
		{
			Character->bTyping = bShowsOpen;
		}
		ApplyGameInputMode(PC);
	}
	const FEarthAction* Action = EarthMenu::Find(Id);
	if (Action && !Typed.IsEmpty())
	{
		RunCommand(Action->Command, Typed);
	}
}

void AEarthWalkHUD::UpdateWhere()
{
	const APlayerController* PC = GetOwningPlayerController();
	const AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	if (!Earth || !Character || !Overlay.IsValid())
	{
		return;
	}
	if (Character->IsWaitingForGround())
	{
		// On the way somewhere: the old name no longer holds, and the new one is asked for on landing.
		WhereName.Reset();
		WhereCountry.Reset();
		WhereKey.Reset();
		WhereAskAt = 0.0;
		Overlay->SetWhere(TEXT("Travelling..."), FString());
		return;
	}
	double Lat, Lon, Alt;
	Earth->WorldToGeo(Character->GetActorLocation(), Lat, Lon, Alt);
	// The server names squares about a kilometre across, so ask again only on entering another one.
	const FString Key = FString::Printf(TEXT("%.2f,%.2f"), Lat, Lon);
	if (Key != WhereKey)
	{
		WhereKey = Key;
		WhereLat = Lat;
		WhereLon = Lon;
		WhereAskAt = FPlatformTime::Seconds() + WhereDelaySeconds;
	}
	// Until the answer comes, and where the place has no name, the coordinates stand in for it.
	const FString Coords = FString::Printf(TEXT("%.4f, %.4f"), Lat, Lon);
	TArray<FString> Under;
	if (!WhereCountry.IsEmpty())
	{
		Under.Add(WhereCountry);
	}
	if (!WhereName.IsEmpty())
	{
		Under.Add(Coords);
	}
	Overlay->SetWhere(WhereName.IsEmpty() ? Coords : WhereName, FString::Join(Under, TEXT("  ·  ")));
}

void AEarthWalkHUD::LookUpWhere(const FString& Key, double Lat, double Lon)
{
	const FString Url = FString::Printf(TEXT("%s/v1/place?lat=%.2f&lon=%.2f"), *FEarthWalkConfig::ServerUrl(), Lat, Lon);
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(30.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Key](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		if (WhereKey != Key)
		{
			return; // moved on meanwhile
		}
		// Anything but a good answer (an older server has no such route) leaves the coordinates up.
		FString Name, Country;
		TSharedPtr<FJsonObject> Json;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200
			&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Json) && Json.IsValid())
		{
			Json->TryGetStringField(TEXT("name"), Name);
			Json->TryGetStringField(TEXT("country"), Country);
		}
		const bool bChanged = Name != WhereName;
		WhereName = Name;
		WhereCountry = Country;
		UE_LOG(LogTemp, Log, TEXT("EarthWalk: where: %s is \"%s\", %s"), *Key, *Name, *Country);
		UpdateWhere();
		if (bChanged && !Name.IsEmpty() && Overlay.IsValid())
		{
			Overlay->Arrive(); // a little flourish, so arriving somewhere is noticed
		}
	});
	Request->ProcessRequest();
}

FString AEarthWalkHUD::StatusText() const
{
	const APlayerController* PC = GetOwningPlayerController();
	const AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const AEarthWorld* Earth = AEarthWorld::Get(this);
	const UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;

	FString Text;
	if (Earth && Character)
	{
		double Lat, Lon, Alt;
		Earth->WorldToGeo(Character->GetActorLocation(), Lat, Lon, Alt);
		Text = FString::Printf(TEXT("%.5f, %.5f"), Lat, Lon);
		if (Character->IsFlying())
		{
			Text += TEXT("  |  flying");
		}
		if (Earth->GetWorldKind() == EEarthWorldKind::Auto && Earth->IsShowingPhoto())
		{
			Text += TEXT("  |  photographic view");
		}
		if (Character->IsRunning())
		{
			Text += TEXT("  |  running");
		}
		if (Character->IsWaitingForGround())
		{
			Text += Earth->GetLastError().IsEmpty() ? FString(TEXT("  |  building the world here...")) : TEXT("  |  ") + Earth->GetLastError();
		}
	}
	if (Net)
	{
		Text += Net->IsConnected()
			? FString::Printf(TEXT("  |  room \"%s\": %d here"), *Net->GetRoom(), Net->GetPeers().Num() + 1)
			: FString(TEXT("  |  meetup server: not connected"));
	}
	return Text;
}

void AEarthWalkHUD::Submit(const FString& Text)
{
	if (!Text.StartsWith(TEXT("/")))
	{
		UEarthCompany* Friends = Company();
		if (Friends && Friends->IsTalking())
		{
			Friends->Say(Text); // to the cow, not to the room
		}
		else if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
		{
			Net->SendChat(Text);
		}
		return;
	}
	FString Command, Argument;
	if (!Text.RightChop(1).Split(TEXT(" "), &Command, &Argument))
	{
		Command = Text.RightChop(1);
	}
	RunCommand(Command.ToLower(), Argument.TrimStartAndEnd());
}

void AEarthWalkHUD::RunCommand(const FString& Command, const FString& Argument)
{
	UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	APlayerController* PC = GetOwningPlayerController();
	AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;

	if (Command == TEXT("menu"))
	{
		if (bMenuOpen)
		{
			CloseMenu();
		}
		else
		{
			OpenMenu();
		}
	}
	else if (Command == TEXT("buttons"))
	{
		ToggleStrip();
	}
	else if (Command == TEXT("do"))
	{
		// One thing from the menu by its name there ("/do goto"): what a button of the strip does.
		MenuAction(Argument.ToLower());
	}
	else if (Command == TEXT("help"))
	{
		AddLine(TEXT("Tab   everything you can do, to click. The buttons along the bottom are the most used; Z hides them and brings them back."), NoticeColor);
		AddLine(TEXT("The same things as typed commands, for those who like typing:"), NoticeColor);
		AddLine(TEXT("/goto <place or lat, lon>   travel anywhere, e.g. /goto Times Square"), NoticeColor);
		AddLine(TEXT("/join <name>   go to someone in your room        /who   list who is here"), NoticeColor);
		AddLine(TEXT("/name <name>   /animal <fox, bear, rabbit, cat, owl or frog>   /room <room>"), NoticeColor);
		AddLine(TEXT("    (your passport, P, has the six animals to choose from too: \"Your animal\")"), NoticeColor);
		AddLine(TEXT("G   Show me: a list of things to show somebody (catch a train, ride a horse, drive a car, walk into a house...)."), NoticeColor);
		AddLine(TEXT("    Click one, or press its number, and you are taken straight to it. /show train does the same without the list."), NoticeColor);
		AddLine(TEXT("Esc, and Esc again   leave the game (or /quit). Where you are is remembered for next time."), NoticeColor);
		AddLine(TEXT("/server <address>   /code <access code>"), NoticeColor);
		AddLine(TEXT("/login   sign in with Google (opens your browser)        /logout   forget this sign-in"), NoticeColor);
		AddLine(TEXT("/home   make where you stand your home (or /home <place>); you start there next time"), NoticeColor);
		AddLine(TEXT("/where   show your coordinates        /fly   toggle flying (also the F key)"), NoticeColor);
		AddLine(TEXT("/sound on   /sound off   the animals' voices, car horns and train whistles"), NoticeColor);
		AddLine(TEXT("/look flat   bright flat colours and bold black lines, like a television cartoon        /look barnyard   the painted look"), NoticeColor);
		AddLine(TEXT("/world auto   ours on foot, Google's photographic 3D world from the air (needs /mapskey <key>)"), NoticeColor);
		AddLine(TEXT("/world photo   the photographic world everywhere        /world generated   ours everywhere"), NoticeColor);
		AddLine(TEXT("Keys: drag or arrows to look, 2 run / 1 walk (or hold Shift), V camera view, wheel zoom"), NoticeColor);
		AddLine(TEXT("E   hop on what is nearest (horse, cow, sheep, camel, llama, kangaroo, deer, tractor, car, boat, train), or hop off"), NoticeColor);
		AddLine(TEXT("    In a car, taxi or tractor you drive: W and S are the pedals, A and D steer, Space is the handbrake, and the mouse looks round the car."), NoticeColor);
		AddLine(TEXT("/car   bring your own car to where you are (choose its paint in your passport); /car away sends it off"), NoticeColor);
		AddLine(TEXT("R   a race along the roads here: R sets one up, R joins one a friend has set up, and R starts yours"), NoticeColor);
		AddLine(TEXT("    (/race stop leaves it, or ends your own). Go on foot, on a horse or in a car: every gate in turn."), NoticeColor);
		AddLine(TEXT("T   talk to what is nearest (animals, cars, trains, trees, houses); what you then type goes to it. Esc stops."), NoticeColor);
		AddLine(TEXT("    Tell it what to do: follow me, come here, stay, go home, do a trick. Riding it, say where to: take me to the beach"), NoticeColor);
		AddLine(TEXT("P   your passport (or /passport): today's three tasks, favours you were asked, treasure hunts and expeditions to set out on,"), NoticeColor);
		AddLine(TEXT("    your coins and hats, riddles, countries, places, friends, stamps and your level. Its buttons work with the mouse."), NoticeColor);
		AddLine(TEXT("/clue   hear again the clue of the treasure hunt you are on"), NoticeColor);
		AddLine(TEXT("E   at a front door with a yellow COME IN sign: go in, and E again just inside it to come out"), NoticeColor);
		AddLine(TEXT("/house   say where the nearest house you can go into is"), NoticeColor);
		AddLine(TEXT("/taxi <place>   call a taxi; it drives to you, and E beside it gets you a ride there"), NoticeColor);
	}
	else if (Command == TEXT("goto") && !Argument.IsEmpty())
	{
		GoToPlace(Argument);
	}
	else if (Command == TEXT("join") && !Argument.IsEmpty())
	{
		GoToPerson(Argument);
	}
	else if (Command == TEXT("who"))
	{
		ShowPeople();
	}
	else if (Command == TEXT("login"))
	{
		if (Net && Net->IsSignedIn())
		{
			AddLine(FString::Printf(TEXT("You are already signed in as %s. /logout forgets this sign-in."), *Net->GetMyName()), NoticeColor);
		}
		else if (Net)
		{
			Net->BeginLogin();
		}
	}
	else if (Command == TEXT("logout"))
	{
		if (Net)
		{
			Net->Logout();
		}
	}
	else if (Command == TEXT("home"))
	{
		if (!Net || !Net->IsConnected())
		{
			AddLine(TEXT("Not connected to the meetup server."), ErrorColor);
		}
		else if (!Net->IsSignedIn())
		{
			AddLine(TEXT("Sign in first (/login) to have a home."), ErrorColor);
		}
		else if (Argument.IsEmpty())
		{
			if (Character && Character->IsWaitingForGround())
			{
				AddLine(TEXT("Wait until you have landed, then try /home again."), ErrorColor);
			}
			else
			{
				Net->SendHome();
			}
		}
		else
		{
			LookUpPlace(Argument, [this](const FString& Name, double Lat, double Lon)
			{
				if (UEarthWalkNet* NetNow = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
				{
					NetNow->SendHome(Lat, Lon, Name);
				}
			});
		}
	}
	else if (Command == TEXT("where"))
	{
		const AEarthWorld* Earth = AEarthWorld::Get(this);
		if (Earth && Character)
		{
			double Lat, Lon, Alt;
			Earth->WorldToGeo(Character->GetActorLocation(), Lat, Lon, Alt);
			AddLine(FString::Printf(TEXT("You are at %.6f, %.6f, %.0f m above sea level."), Lat, Lon, Alt), NoticeColor);
		}
	}
	else if (Command == TEXT("world") && (Argument.Equals(TEXT("photo"), ESearchCase::IgnoreCase) || Argument.Equals(TEXT("generated"), ESearchCase::IgnoreCase) || Argument.Equals(TEXT("auto"), ESearchCase::IgnoreCase)))
	{
		AEarthWorld* Earth = AEarthWorld::Get(this);
		if (Earth && Character)
		{
			const EEarthWorldKind Kind = Argument.Equals(TEXT("photo"), ESearchCase::IgnoreCase) ? EEarthWorldKind::Photo
				: Argument.Equals(TEXT("auto"), ESearchCase::IgnoreCase) ? EEarthWorldKind::Auto
				: EEarthWorldKind::Generated;
			double Lat, Lon, Alt;
			Earth->WorldToGeo(Character->GetActorLocation(), Lat, Lon, Alt);
			FString Reason;
			if (Earth->SetWorldKind(Kind, Reason))
			{
				AddLine(Kind == EEarthWorldKind::Photo ? TEXT("Switching to the photographic world (Google 3D tiles). A new place takes up to half a minute.")
					: Kind == EEarthWorldKind::Auto ? TEXT("Our world on foot, the photographic world from the air: press F and fly up.")
					: TEXT("Back to the generated world."), NoticeColor);
				Character->TeleportToGeo(Lat, Lon); // reload the world in place
			}
			else
			{
				AddLine(Reason, ErrorColor);
			}
		}
	}
	else if (Command == TEXT("quit") || Command == TEXT("exit"))
	{
		UKismetSystemLibrary::QuitGame(this, PC, EQuitPreference::Quit, false);
	}
	else if (Command == TEXT("look"))
	{
		EEarthLook Look;
		if (EarthLook::Parse(Argument, Look))
		{
			EarthLook::Choose(GetWorld(), Look);
			AddLine(Look == EEarthLook::Flat
				? TEXT("The flat look: bright even colours and a bold black line. /look barnyard goes back.")
				: TEXT("The barnyard look: painted, with brushwork. /look flat is the other one."), NoticeColor);
		}
		else
		{
			AddLine(FString::Printf(TEXT("This is the %s look. /look flat   bright flat colours and bold black lines        /look barnyard   the painted look"), EarthLook::Name(EarthLook::Current())), NoticeColor);
		}
	}
	else if (Command == TEXT("mapskey") && !Argument.IsEmpty())
	{
		// Kept in this PC's own settings, never sent to the room and never echoed.
		FEarthWalkConfig::Save(TEXT("MapsKey"), Argument);
		AddLine(TEXT("Saved the Google Map Tiles key on this PC. Type /world auto to use it."), NoticeColor);
	}
	else if (Command == TEXT("sound"))
	{
		const AEarthWorld* Earth = AEarthWorld::Get(this);
		UEarthSounds* Sounds = Earth && Earth->GetLife() ? Earth->GetLife()->GetSounds() : nullptr;
		if (Sounds && (Argument.Equals(TEXT("on"), ESearchCase::IgnoreCase) || Argument.Equals(TEXT("off"), ESearchCase::IgnoreCase)))
		{
			const bool bOn = Argument.Equals(TEXT("on"), ESearchCase::IgnoreCase);
			Sounds->SetEnabled(bOn);
			FEarthWalkConfig::Save(TEXT("Sound"), bOn ? TEXT("on") : TEXT("off"));
			AddLine(bOn ? TEXT("Sound is on: animals call, cars toot and trains whistle.") : TEXT("Sound is off."), NoticeColor);
		}
		else if (Sounds)
		{
			AddLine(FString::Printf(TEXT("Sound is %s. Type /sound on or /sound off."), Sounds->IsEnabled() ? TEXT("on") : TEXT("off")), NoticeColor);
		}
	}
	else if (Command == TEXT("passport") || Command == TEXT("journal"))
	{
		TogglePassport();
	}
	else if (Command == TEXT("show") || Command == TEXT("showme"))
	{
		const AEarthWorld* Earth = AEarthWorld::Get(this);
		UEarthShowcase* Showcase = Earth ? Earth->GetShowcase() : nullptr;
		if (Argument.IsEmpty())
		{
			if (!bShowsOpen)
			{
				ToggleShows();
			}
		}
		else if (Showcase)
		{
			Showcase->Go(Argument);
		}
	}
	else if (Command == TEXT("animal"))
	{
		BecomeAnimal(Argument);
	}
	else if (Command == TEXT("house") || Command == TEXT("houses"))
	{
		const UEarthCompany* Friends = Company();
		const FString Where = Friends ? Friends->NearestHouse() : FString();
		AddLine(Where.IsEmpty()
			? FString(TEXT("No house near here can be gone into. Most houses open, so try the next street; shops, sheds and big buildings do not."))
			: FString::Printf(TEXT("The nearest house you can go into is %s. Look for the yellow COME IN sign over its front door, and press E there."), *Where), NoticeColor);
	}
	else if (Command == TEXT("race"))
	{
		if (UEarthCompany* Friends = Company())
		{
			Friends->KeyRace(Argument.ToLower());
		}
	}
	else if (Command == TEXT("car"))
	{
		if (UEarthCompany* Friends = Company())
		{
			Friends->CallCar(Argument.Equals(TEXT("away"), ESearchCase::IgnoreCase));
		}
	}
	else if (Command == TEXT("clue"))
	{
		if (Net && Net->IsConnected())
		{
			bCluePending = true;
			Net->RequestJournal();
		}
		else
		{
			AddLine(TEXT("Not connected to the meetup server."), ErrorColor);
		}
	}
	else if (Command == TEXT("taxi"))
	{
		if (Argument.IsEmpty())
		{
			AddLine(TEXT("Say where to, like this: /taxi the beach"), NoticeColor);
		}
		else if (UEarthCompany* Friends = Company())
		{
			Friends->CallTaxi(Argument);
		}
	}
	else if (Command == TEXT("fly"))
	{
		if (Character)
		{
			Character->SetFlying(!Character->IsFlying());
		}
	}
	else if ((Command == TEXT("name") || Command == TEXT("room") || Command == TEXT("server") || Command == TEXT("code")) && !Argument.IsEmpty())
	{
		const TCHAR* Key = Command == TEXT("name") ? TEXT("Name") : Command == TEXT("room") ? TEXT("Room") : Command == TEXT("server") ? TEXT("Server") : TEXT("Code");
		FEarthWalkConfig::Save(Key, Argument);
		AddLine(TEXT("Saved. Reconnecting..."), NoticeColor);
		if (Net)
		{
			Net->Connect();
		}
		if ((Command == TEXT("server") || Command == TEXT("code")) && Character)
		{
			// Reload the world from the new server.
			const AEarthWorld* Earth = AEarthWorld::Get(this);
			double Lat, Lon, Alt;
			if (Earth)
			{
				Earth->WorldToGeo(Character->GetActorLocation(), Lat, Lon, Alt);
				Character->TeleportToGeo(Lat, Lon);
			}
		}
	}
	else
	{
		AddLine(TEXT("Unknown command. Type /help to see what you can do."), ErrorColor);
	}
}

/** "5 min ago", "3 h ago", for the people list. */
static FString Ago(int64 WhenMs)
{
	const int64 Minutes = (FDateTime::UtcNow().ToUnixTimestamp() * 1000 - WhenMs) / 60000;
	if (Minutes < 2) return TEXT("just now");
	if (Minutes < 60) return FString::Printf(TEXT("%lld min ago"), Minutes);
	if (Minutes < 48 * 60) return FString::Printf(TEXT("%lld h ago"), (Minutes + 30) / 60);
	return FString::Printf(TEXT("%lld days ago"), (Minutes + 720) / 1440);
}

void AEarthWalkHUD::ShowPeople()
{
	UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	TArray<FString> Names;
	if (Net)
	{
		for (const TPair<FString, FEarthPeer>& Pair : Net->GetPeers())
		{
			Names.Add(Pair.Value.Name);
		}
	}
	AddLine(Names.Num() ? FString::Printf(TEXT("Here with you: %s"), *FString::Join(Names, TEXT(", "))) : FString(TEXT("Nobody else is in this room right now.")), NoticeColor);
	if (!Net || !Net->IsSignedIn())
	{
		return;
	}
	for (const FEarthPerson& Person : Net->GetPeople())
	{
		const FString Where = Person.bOnline
			? FString::Printf(TEXT("in \"%s\"%s"), *Person.Room, Person.Place.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(", %s"), *Person.Place))
			: FString::Printf(TEXT("offline, last seen %s%s"), *Ago(Person.LastSeen), Person.Place.IsEmpty() ? TEXT("") : *FString::Printf(TEXT(" near %s"), *Person.Place));
		AddLine(FString::Printf(TEXT("%s: %s"), *Person.Name, *Where), NoticeColor);
	}
	if (Net->GetPeople().Num() == 0)
	{
		AddLine(TEXT("Nobody else has signed in yet."), NoticeColor);
	}
	Net->RequestPeople(); // refresh for next time
}

void AEarthWalkHUD::GoToPerson(const FString& Name)
{
	const UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	APlayerController* PC = GetOwningPlayerController();
	AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	if (!Net || !Character)
	{
		return;
	}
	// Exact name first, then anything that starts with what was typed.
	const FEarthPeer* Match = nullptr;
	for (const TPair<FString, FEarthPeer>& Pair : Net->GetPeers())
	{
		if (Pair.Value.Name.Equals(Name, ESearchCase::IgnoreCase))
		{
			Match = &Pair.Value;
			break;
		}
		if (!Match && Pair.Value.Name.StartsWith(Name, ESearchCase::IgnoreCase))
		{
			Match = &Pair.Value;
		}
	}
	if (!Match)
	{
		// Not in this room: maybe somewhere else on the people list.
		for (const FEarthPerson& Person : Net->GetPeople())
		{
			if (Person.Name.Equals(Name, ESearchCase::IgnoreCase) || Person.Name.StartsWith(Name, ESearchCase::IgnoreCase))
			{
				if (!Person.bOnline)
				{
					AddLine(FString::Printf(TEXT("%s is not online right now (last seen %s)."), *Person.Name, *Ago(Person.LastSeen)), ErrorColor);
				}
				else if (!Person.bHasPosition)
				{
					AddLine(FString::Printf(TEXT("%s has not arrived anywhere yet. Try again in a moment."), *Person.Name), ErrorColor);
				}
				else
				{
					AddLine(FString::Printf(TEXT("%s is in room \"%s\". Switching rooms and travelling there..."), *Person.Name, *Person.Room), NoticeColor);
					FEarthWalkConfig::Save(TEXT("Room"), Person.Room);
					if (UEarthWalkNet* NetNow = GetGameInstance()->GetSubsystem<UEarthWalkNet>())
					{
						NetNow->Connect();
					}
					Character->TeleportToGeo(Person.Lat + 0.00003, Person.Lon);
				}
				return;
			}
		}
		AddLine(FString::Printf(TEXT("Nobody called \"%s\" is here. Type /who to see who is around."), *Name), ErrorColor);
	}
	else if (!Match->bHasPosition)
	{
		AddLine(FString::Printf(TEXT("%s has not arrived anywhere yet. Try again in a moment."), *Match->Name), ErrorColor);
	}
	else
	{
		AddLine(FString::Printf(TEXT("Travelling to %s..."), *Match->Name), NoticeColor);
		// Arrive a few metres away rather than exactly on top of them.
		Character->TeleportToGeo(Match->Lat + 0.00003, Match->Lon);
	}
}

void AEarthWalkHUD::GoToPlace(const FString& Query)
{
	LookUpPlace(Query, [this](const FString& Name, double Lat, double Lon)
	{
		AddLine(FString::Printf(TEXT("Travelling to %s"), *Name), NoticeColor);
		APlayerController* PC = GetOwningPlayerController();
		if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
		{
			Character->TeleportToGeo(Lat, Lon);
		}
	});
}

void AEarthWalkHUD::LookUpPlace(const FString& Query, TFunction<void(const FString& Name, double Lat, double Lon)> Found)
{
	const FString Url = FString::Printf(TEXT("%s/v1/geocode?q=%s"), *FEarthWalkConfig::ServerUrl(), *FGenericPlatformHttp::UrlEncode(Query));
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(30.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	AddLine(FString::Printf(TEXT("Looking for \"%s\"..."), *Query), NoticeColor);
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Query, Found](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		if (!bConnected || !Response.IsValid())
		{
			AddLine(TEXT("Could not reach the world server to look that up."), ErrorColor);
			return;
		}
		TSharedPtr<FJsonObject> Json;
		const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
		double Lat = 0.0, Lon = 0.0;
		if (Response->GetResponseCode() != 200 || !FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid() ||
			!Json->TryGetNumberField(TEXT("lat"), Lat) || !Json->TryGetNumberField(TEXT("lon"), Lon))
		{
			AddLine(FString::Printf(TEXT("Could not find \"%s\". Try a fuller name, or coordinates like 48.8583, 2.2945."), *Query), ErrorColor);
			return;
		}
		FString Name;
		Json->TryGetStringField(TEXT("name"), Name);
		Found(Name, Lat, Lon);
	});
	Request->ProcessRequest();
}
