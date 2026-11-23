#include "EarthProgress.h"

#include "Brushes/SlateColorBrush.h"
#include "Brushes/SlateRoundedBoxBrush.h"
#include "Dom/JsonObject.h"
#include "EarthWalkHUD.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Rendering/DrawElements.h"
#include "Styling/CoreStyle.h"
#include "Styling/SlateTypes.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SLeafWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
	// As progress.js: how long a note stays, less when more news is waiting, and how long a new level is made of.
	constexpr double NoteSeconds = 3.2;
	constexpr double NoteSecondsBusy = 1.5;
	constexpr double BrimSeconds = 0.65;
	constexpr double LevelSeconds = 5.2;
	constexpr double PaperSeconds = 2.4;
	constexpr int32 PaperBits = 26;

	const FLinearColor ProgressPanel(FColor(22, 28, 38, 225));
	const FLinearColor ProgressDim(1.f, 1.f, 1.f, 0.66f);
	const FLinearColor ProgressGold(FColor(245, 197, 24));
	const FLinearColor ProgressGreen(FColor(74, 176, 92));
	const FLinearColor ProgressInk(FColor(34, 30, 26));
	const FLinearColor ProgressCream(FColor(250, 244, 226));
	const FLinearColor ProgressPlus(FColor(40, 132, 58));

	/** Where the bar is on the screen: under the five hearts (EarthLunch.cpp puts them at 12, 40). */
	constexpr float BarLeft = 12.f;
	constexpr float BarTop = 70.f;
	constexpr float BarWide = 226.f;

	uint32 PaperHash(uint32 A, uint32 B)
	{
		uint32 H = A * 0x9e3779b1u ^ (B + 0x7f4a7c15u) * 0x85ebca6bu;
		H ^= H >> 15;
		H *= 0x2c1b3c6du;
		H ^= H >> 12;
		return H;
	}
	float PaperUnit(uint32 A, uint32 B) { return static_cast<float>(PaperHash(A, B) & 0xffffff) / 16777216.f; }
}

/** The coloured paper thrown from the badge at a new level: drawn over the whole screen, and never in the mouse's way. */
class SEarthProgressPaper : public SLeafWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthProgressPaper) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, UEarthProgress* InOwner)
	{
		Owner = InOwner;
		SetVisibility(EVisibility::HitTestInvisible);
	}

	virtual FVector2D ComputeDesiredSize(float) const override { return FVector2D::ZeroVector; }

	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geo, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		const UEarthProgress* Bar = Owner.Get();
		const double T = Bar ? Bar->GetPaperAge() : -1.0;
		if (T < 0.0 || T > PaperSeconds)
		{
			return Layer;
		}
		static const FLinearColor Colours[] = { FLinearColor(FColor(232, 72, 68)), FLinearColor(FColor(245, 197, 24)), FLinearColor(FColor(74, 176, 92)), FLinearColor(FColor(70, 140, 226)), FLinearColor(FColor(236, 126, 190)) };
		const FVector2f From(BarLeft + 30.f, BarTop + 26.f); // the badge
		const float Time = static_cast<float>(T);
		const float Fade = FMath::Clamp((static_cast<float>(PaperSeconds) - Time) / 0.7f, 0.f, 1.f);
		for (int32 i = 0; i < PaperBits; ++i)
		{
			// Each bit flies out to the right and a little up or down, slows, and falls.
			const float Turn = FMath::DegreesToRadians(-70.f + 150.f * PaperUnit(i, 1));
			const float Pace = 110.f + 250.f * PaperUnit(i, 2);
			const float Out01 = 1.f - FMath::Exp(-2.2f * Time);
			const FVector2f At = From + FVector2f(FMath::Cos(Turn), FMath::Sin(Turn)) * Pace * Out01 * 0.9f + FVector2f(0.f, 70.f * Time * Time);
			const float Flip = FMath::Abs(FMath::Sin(Time * (5.f + 6.f * PaperUnit(i, 3)) + 6.28f * PaperUnit(i, 4)));
			const FVector2f Size(10.f + 6.f * PaperUnit(i, 5), 4.f + 10.f * Flip);
			FLinearColor Colour = Colours[PaperHash(i, 6) % UE_ARRAY_COUNT(Colours)];
			Colour.A = Fade;
			// (An ink edge under each bit, so that it reads against a pale sky.)
			FSlateDrawElement::MakeBox(Out, Layer + 1, Geo.ToPaintGeometry(Size + FVector2f(3.f, 3.f), FSlateLayoutTransform(At - Size * 0.5f - FVector2f(1.5f, 1.5f))), &Flat, ESlateDrawEffect::None, FLinearColor(0.1f, 0.09f, 0.08f, Fade));
			FSlateDrawElement::MakeBox(Out, Layer + 2, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(At - Size * 0.5f)), &Flat, ESlateDrawEffect::None, Colour);
		}
		return Layer + 2;
	}

private:
	TWeakObjectPtr<UEarthProgress> Owner;
	FSlateColorBrush Flat = FSlateColorBrush(FLinearColor::White);
};

/** The bar under the hearts, the note under the bar, and the coloured paper over everything. */
class SEarthProgressView : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthProgressView) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, UEarthProgress* InOwner)
	{
		SetVisibility(EVisibility::SelfHitTestInvisible);
		const TWeakObjectPtr<UEarthProgress> Bar = InOwner;
		const auto Words = [](const TCHAR* Face, int32 Size, const FLinearColor& Colour)
		{
			return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Colour);
		};
		ChildSlot
		[
			SNew(SOverlay)
			+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(BarLeft, BarTop, 0.f, 0.f)
			[
				SNew(SVerticalBox)
				.Visibility_Lambda([Bar]() { return Bar.IsValid() && Bar->IsKnown() ? EVisibility::SelfHitTestInvisible : EVisibility::Collapsed; })
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left)
				[
					SNew(SButton)
					.IsFocusable(false)
					.ButtonStyle(&Clear)
					.ContentPadding(FMargin(0.f))
					.ToolTipText_Lambda([Bar]()
					{
						const UEarthProgress* P = Bar.Get();
						if (!P)
						{
							return FText::GetEmpty();
						}
						const FEarthLevel& L = P->GetLevel();
						return FText::FromString(FString::Printf(TEXT("Level %d, %s: %d points, %d more to level %d. Click to open your passport (P)."),
							L.N, *L.Title, FMath::RoundToInt32(L.Points), FMath::Max(0, FMath::RoundToInt32(L.Next - L.Points)), L.N + 1));
					})
					.OnClicked_Lambda([Bar]()
					{
						if (UEarthProgress* P = Bar.Get())
						{
							P->Clicked();
						}
						return FReply::Handled();
					})
					[
						SNew(SBorder)
						.BorderImage(&PanelBrush)
						// A gold ring of light round the bar while a new level is being made of.
						.BorderBackgroundColor_Lambda([Bar]() { return Bar.IsValid() && Bar->IsUp() ? FSlateColor(FLinearColor(FColor(96, 76, 14, 240))) : FSlateColor(ProgressPanel); })
						.Padding(FMargin(8.f, 6.f, 12.f, 7.f))
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 9.f, 0.f)
							[
								SNew(SBox).WidthOverride(34.f).HeightOverride(34.f)
								[
									SNew(SBorder)
									.BorderImage(&Round)
									.BorderBackgroundColor_Lambda([Bar]() { return Bar.IsValid() && Bar->IsLit() ? FSlateColor(FLinearColor(FColor(255, 226, 110))) : FSlateColor(ProgressGold); })
									.HAlign(HAlign_Center).VAlign(VAlign_Center)
									.Padding(FMargin(0.f))
									[
										SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 14)).ColorAndOpacity(ProgressInk)
										.Text_Lambda([Bar]() { return Bar.IsValid() ? FText::AsNumber(Bar->GetLevel().N) : FText::GetEmpty(); })
									]
								]
							]
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
							[
								SNew(SBox).WidthOverride(BarWide)
								[
									SNew(SVerticalBox)
									+ SVerticalBox::Slot().AutoHeight()
									[
										SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 13)).ColorAndOpacity(FLinearColor::White)
										.Text_Lambda([Bar]() { return Bar.IsValid() ? FText::FromString(Bar->GetLevel().Title) : FText::GetEmpty(); })
									]
									+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 3.f)
									[
										// The bar: a dark groove, and in it as much green as the level is done (gold while points come in).
										SNew(SBox).HeightOverride(10.f)
										[
											SNew(SBorder)
											.BorderImage(&Groove)
											.BorderBackgroundColor(FLinearColor(FColor(8, 12, 18, 235)))
											.Padding(FMargin(0.f))
											.HAlign(HAlign_Left)
											[
												SNew(SBox)
												.WidthOverride_Lambda([Bar]() { return FOptionalSize(FMath::Max(Bar.IsValid() && Bar->GetFill() > 0.005f ? 10.f : 0.f, BarWide * (Bar.IsValid() ? Bar->GetFill() : 0.f))); })
												[
													SNew(SBorder)
													.BorderImage(&Groove)
													.BorderBackgroundColor_Lambda([Bar]() { return Bar.IsValid() && Bar->IsLit() ? FSlateColor(ProgressGold) : FSlateColor(ProgressGreen); })
												]
											]
										]
									]
									+ SVerticalBox::Slot().AutoHeight()
									[
										SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 10)).ColorAndOpacity(ProgressDim).WrapTextAt(BarWide)
										.Text_Lambda([Bar]() { return Bar.IsValid() ? FText::FromString(Bar->GetHint()) : FText::GetEmpty(); })
									]
								]
							]
						]
					]
				]
				// The note: what has just earned points, or what a new level gave.
				+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left).Padding(0.f, 6.f, 0.f, 0.f)
				[
					SNew(SBorder)
					.BorderImage(&NoteBrush)
					.BorderBackgroundColor(ProgressCream)
					.Padding(FMargin(12.f, 6.f, 14.f, 7.f))
					.Visibility_Lambda([Bar]() { return Bar.IsValid() && !(Bar->GetNotePlus().IsEmpty() && Bar->GetNoteBig().IsEmpty()) ? EVisibility::HitTestInvisible : EVisibility::Collapsed; })
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 19)).ColorAndOpacity(ProgressInk)
							.Visibility_Lambda([Bar]() { return Bar.IsValid() && !Bar->GetNoteBig().IsEmpty() ? EVisibility::HitTestInvisible : EVisibility::Collapsed; })
							.Text_Lambda([Bar]() { return Bar.IsValid() ? FText::FromString(Bar->GetNoteBig()) : FText::GetEmpty(); })
						]
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 7.f, 0.f)
							[
								SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 14)).ColorAndOpacity(ProgressPlus)
								.Visibility_Lambda([Bar]() { return Bar.IsValid() && !Bar->GetNotePlus().IsEmpty() ? EVisibility::HitTestInvisible : EVisibility::Collapsed; })
								.Text_Lambda([Bar]() { return Bar.IsValid() ? FText::FromString(Bar->GetNotePlus()) : FText::GetEmpty(); })
							]
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
							[
								SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 12)).ColorAndOpacity(ProgressInk).WrapTextAt(300.f)
								.Text_Lambda([Bar]() { return Bar.IsValid() ? FText::FromString(Bar->GetNoteWords()) : FText::GetEmpty(); })
							]
						]
					]
				]
			]
			+ SOverlay::Slot()
			[
				SNew(SEarthProgressPaper, InOwner)
			]
		];
	}

private:
	FSlateRoundedBoxBrush PanelBrush = FSlateRoundedBoxBrush(FLinearColor::White, 12.f);
	FSlateRoundedBoxBrush NoteBrush = FSlateRoundedBoxBrush(FLinearColor::White, 10.f);
	FSlateRoundedBoxBrush Round = FSlateRoundedBoxBrush(FLinearColor::White, 17.f);
	FSlateRoundedBoxBrush Groove = FSlateRoundedBoxBrush(FLinearColor::White, 5.f);
	FButtonStyle Clear = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(0.f, 0.f, 0.f, 0.f), 12.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 40)), 12.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 70)), 12.f));
};

UEarthWalkNet* UEarthProgress::Room() const
{
	const AEarthWalkHUD* Screen = Hud.Get();
	return Screen && Screen->GetGameInstance() ? Screen->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
}

void UEarthProgress::Setup(AEarthWalkHUD* InHud)
{
	if (!InHud || !GEngine || !GEngine->GameViewport)
	{
		return;
	}
	Hud = InHud;
	SAssignNew(View, SEarthProgressView, this);
	// With the hearts: under the menu and the passport, over the little map.
	GEngine->GameViewport->AddViewportWidgetContent(View.ToSharedRef(), 10);
	if (UEarthWalkNet* Net = Room())
	{
		ProgressHandle = Net->OnProgress.AddWeakLambda(this, [this](const FEarthProgress& News) { Take(News); });
		// The journal says where the player stands too: after anything that sends one, the bar is right.
		JournalHandle = Net->OnJournal.AddWeakLambda(this, [this](const TSharedPtr<FJsonObject>& Journal)
		{
			const TSharedPtr<FJsonObject>* Level = nullptr;
			FEarthProgress News;
			if (Journal.IsValid() && Journal->TryGetObjectField(TEXT("level"), Level) && UEarthWalkNet::ReadLevel(**Level, News.Level))
			{
				Take(News);
			}
		});
	}
}

void UEarthProgress::Shutdown()
{
	if (UEarthWalkNet* Net = Room())
	{
		Net->OnProgress.Remove(ProgressHandle);
		Net->OnJournal.Remove(JournalHandle);
	}
	if (View.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(View.ToSharedRef());
	}
	View.Reset();
}

void UEarthProgress::Clicked()
{
	if (AEarthWalkHUD* Screen = Hud.Get())
	{
		Screen->MenuAction(TEXT("passport"));
	}
}

/** Word of where the player stands. With points just earned it waits its turn to be shown; without, the bar is simply put right. */
void UEarthProgress::Take(const FEarthProgress& News)
{
	if (News.Gained > 0.0 || News.bUp)
	{
		Waiting.Add(News);
		return;
	}
	if (bBusy || Waiting.Num() > 0)
	{
		return; // what is being shown is newer, or as new
	}
	Shown = News.Level;
	Target = FMath::Clamp((Shown.Points - Shown.From) / FMath::Max(1.0, Shown.Next - Shown.From), 0.0, 1.0);
	if (!bKnown)
	{
		Fill = Target; // the first word of it: no creeping up from nothing
	}
	bKnown = true;
}

void UEarthProgress::Start(const FEarthProgress& News)
{
	Now = News;
	bBusy = true;
	bKnown = true;
	Age = 0.0;
	bFlipped = false;
	NoteBig.Reset();
	const int32 Points = FMath::RoundToInt32(News.Gained);
	NotePlus = Points > 0 ? FString::Printf(TEXT("+%d"), Points) : FString();
	NoteWords = News.Why;
	if (News.bUp)
	{
		Target = 1.0; // to the brim first; the new level's words come when it starts again
	}
	else
	{
		Shown = News.Level;
		Target = FMath::Clamp((Shown.Points - Shown.From) / FMath::Max(1.0, Shown.Next - Shown.From), 0.0, 1.0);
	}
}

void UEarthProgress::Frame(float DeltaSeconds)
{
	Clock += DeltaSeconds;
	// -EWProgressShow=gain|level: a made-up piece of news eight seconds in, for pictures.
	if (!bTestShown && Clock > 8.0)
	{
		bTestShown = true;
		FString What;
		if (FParse::Value(FCommandLine::Get(), TEXT("-EWProgressShow="), What))
		{
			FEarthProgress News;
			News.Level = Shown;
			if (What == TEXT("level"))
			{
				News.Level.N = Shown.N + 1;
				News.Level.Title = TEXT("Explorer");
				News.Level.From = Shown.Next;
				News.Level.Next = Shown.Next + 70.0;
				News.Level.Points = Shown.Next + 4.0;
				News.Level.Hint = FString::Printf(TEXT("Three new friends to level %d"), News.Level.N + 1);
				News.Gained = 6.0;
				News.Why = TEXT("met your first horse");
				News.bUp = true;
				News.UpN = News.Level.N;
				News.UpTitle = News.Level.Title;
				News.UpCoins = 10 * News.Level.N;
				News.UpRiddles = 6;
			}
			else
			{
				News.Level.Points = FMath::Min(Shown.Next - 1.0, Shown.Points + 3.0);
				News.Gained = 3.0;
				News.Why = TEXT("fed a hungry cow");
			}
			Waiting.Add(News);
		}
	}

	if (!bBusy && Waiting.Num() > 0)
	{
		const FEarthProgress Next = Waiting[0];
		Waiting.RemoveAt(0);
		Start(Next);
	}
	if (bBusy)
	{
		Age += DeltaSeconds;
		if (Now.bUp && !bFlipped && Age > BrimSeconds)
		{
			// Full: the bar starts again on the new level, and the level is made much of.
			bFlipped = true;
			Shown = Now.Level;
			Fill = 0.0;
			Target = FMath::Clamp((Shown.Points - Shown.From) / FMath::Max(1.0, Shown.Next - Shown.From), 0.0, 1.0);
			PaperAge = 0.0;
			NoteBig = FString::Printf(TEXT("Level %d!"), Now.UpN > 0 ? Now.UpN : Shown.N);
			TArray<FString> Gave;
			if (Now.UpCoins > 0)
			{
				Gave.Add(FString::Printf(TEXT("%d coins"), Now.UpCoins));
			}
			if (Now.UpRiddles > 0)
			{
				Gave.Add(Now.UpRiddles == 1 ? FString(TEXT("a new riddle")) : FString::Printf(TEXT("%d new riddles"), Now.UpRiddles));
			}
			NotePlus.Reset();
			NoteWords = (Now.UpTitle.IsEmpty() ? Shown.Title : Now.UpTitle) + (Gave.Num() > 0 ? TEXT(" · ") + FString::Join(Gave, TEXT(" and ")) : FString());
		}
		const double Lasts = Now.bUp ? LevelSeconds : Waiting.Num() > 0 ? NoteSecondsBusy : NoteSeconds;
		if (Age > Lasts)
		{
			bBusy = false;
			NoteBig.Reset();
			NotePlus.Reset();
			NoteWords.Reset();
		}
	}
	// The bar moves to where it should be in a little over half a second.
	Fill += (Target - Fill) * (1.0 - FMath::Exp(-6.5 * DeltaSeconds));
	if (PaperAge >= 0.0)
	{
		PaperAge += DeltaSeconds;
		if (PaperAge > PaperSeconds)
		{
			PaperAge = -1.0;
		}
	}
}
