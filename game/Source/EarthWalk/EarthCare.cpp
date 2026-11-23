#include "EarthCare.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Dom/JsonObject.h"
#include "EarthCompany.h"
#include "EarthLife.h"
#include "EarthLifeMotion.h"
#include "EarthMounts.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWorld.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Fonts/FontMeasure.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
#include "InputCoreTypes.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "Rendering/DrawElements.h"
#include "Rendering/SlateRenderer.h"
#include "Styling/CoreStyle.h"
#include "Styling/SlateTypes.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/Layout/SWrapBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

namespace
{
	/** How far off a thought bubble is shown, how many at once, and how near an animal must be for the hint: as carebubbles.js. */
	constexpr double CareSeeM = 45.0;
	constexpr int32 CareMost = 14;
	constexpr double CareNearM = 5.0;
	/** One animal in this many is hungry on a given day (care.js). */
	constexpr uint32 CareOneIn = 5;
	/** Where the ring is on the lesson's bar, how fast the paw prints run towards it (dots a millisecond), and how long after the last beat the lesson is handed in: as train.js. */
	constexpr float CareRingAt = 56.f;
	constexpr float CareRun = 0.17f;
	constexpr double CareAfterMs = 700.0;

	const FLinearColor CarePanel(FColor(22, 28, 38, 240));
	const FLinearColor CareDim(1.f, 1.f, 1.f, 0.62f);
	const FLinearColor CareGold(FColor(245, 197, 24));
	const FLinearColor CareInk(FColor(38, 34, 31));

	/** What each kind of animal likes to be given: WANTS of server/public/js/care.js, to be kept in step with it. */
	const TMap<FString, TArray<FString>>& CareWants()
	{
		static const TMap<FString, TArray<FString>> Wants = {
			{ TEXT("duck"), { TEXT("bread"), TEXT("corn") } }, { TEXT("goose"), { TEXT("bread"), TEXT("lettuce") } }, { TEXT("swan"), { TEXT("bread"), TEXT("lettuce") } },
			{ TEXT("chicken"), { TEXT("corn"), TEXT("bread") } }, { TEXT("pigeon"), { TEXT("bread") } }, { TEXT("sparrow"), { TEXT("bread") } },
			{ TEXT("seagull"), { TEXT("fish") } }, { TEXT("heron"), { TEXT("fish") } }, { TEXT("penguin"), { TEXT("fish") } }, { TEXT("seal"), { TEXT("fish") } }, { TEXT("otter"), { TEXT("fish") } },
			{ TEXT("horse"), { TEXT("apple"), TEXT("carrot") } }, { TEXT("donkey"), { TEXT("carrot"), TEXT("apple") } }, { TEXT("zebra"), { TEXT("apple"), TEXT("carrot") } },
			{ TEXT("cow"), { TEXT("apple"), TEXT("corn") } }, { TEXT("sheep"), { TEXT("lettuce"), TEXT("carrot") } }, { TEXT("goat"), { TEXT("lettuce"), TEXT("apple") } },
			{ TEXT("pig"), { TEXT("potato"), TEXT("apple"), TEXT("pumpkin") } }, { TEXT("rabbit"), { TEXT("carrot"), TEXT("lettuce") } }, { TEXT("squirrel"), { TEXT("nuts") } },
			{ TEXT("mouse"), { TEXT("cheese") } }, { TEXT("hedgehog"), { TEXT("apple"), TEXT("egg") } },
			{ TEXT("cat"), { TEXT("fish"), TEXT("milk") } }, { TEXT("dog"), { TEXT("cheese"), TEXT("egg") } }, { TEXT("fox"), { TEXT("egg"), TEXT("berries") } },
			{ TEXT("deer"), { TEXT("apple"), TEXT("carrot") } }, { TEXT("tortoise"), { TEXT("lettuce"), TEXT("tomato") } },
			{ TEXT("monkey"), { TEXT("banana") } }, { TEXT("bear"), { TEXT("honey"), TEXT("berries"), TEXT("fish") } }, { TEXT("capybara"), { TEXT("pumpkin"), TEXT("corn") } },
			{ TEXT("marmot"), { TEXT("lettuce"), TEXT("nuts") } }, { TEXT("beaver"), { TEXT("carrot"), TEXT("apple") } },
			{ TEXT("kangaroo"), { TEXT("carrot"), TEXT("lettuce") } }, { TEXT("llama"), { TEXT("carrot"), TEXT("apple") } }, { TEXT("camel"), { TEXT("fig"), TEXT("carrot") } },
			{ TEXT("elephant"), { TEXT("banana"), TEXT("pumpkin"), TEXT("apple") } }, { TEXT("giraffe"), { TEXT("lettuce"), TEXT("apple") } },
			{ TEXT("bison"), { TEXT("corn") } }, { TEXT("moose"), { TEXT("apple") } }, { TEXT("reindeer"), { TEXT("carrot") } }, { TEXT("lion"), { TEXT("fish") } },
		};
		return Wants;
	}

	/** "an apple", for the line that says what an animal is hungry for. */
	FString CareFoodName(const FString& Food)
	{
		static const TMap<FString, FString> Names = {
			{ TEXT("apple"), TEXT("an apple") }, { TEXT("carrot"), TEXT("a carrot") }, { TEXT("bread"), TEXT("a loaf of bread") }, { TEXT("corn"), TEXT("a corn cob") },
			{ TEXT("lettuce"), TEXT("a lettuce") }, { TEXT("fish"), TEXT("a fish") }, { TEXT("potato"), TEXT("a potato") }, { TEXT("pumpkin"), TEXT("a pumpkin") },
			{ TEXT("nuts"), TEXT("some nuts") }, { TEXT("cheese"), TEXT("some cheese") }, { TEXT("egg"), TEXT("an egg") }, { TEXT("milk"), TEXT("some milk") },
			{ TEXT("berries"), TEXT("some berries") }, { TEXT("tomato"), TEXT("a tomato") }, { TEXT("banana"), TEXT("a banana") }, { TEXT("honey"), TEXT("some honey") }, { TEXT("fig"), TEXT("a fig") },
		};
		const FString* Found = Names.Find(Food);
		return Found ? *Found : FString(TEXT("something"));
	}

	/** Small animals have their bubble lower. */
	bool CareIsLow(const FString& Sp)
	{
		static const TSet<FString> Low = {
			TEXT("duck"), TEXT("goose"), TEXT("swan"), TEXT("chicken"), TEXT("pigeon"), TEXT("sparrow"), TEXT("seagull"), TEXT("heron"), TEXT("rabbit"), TEXT("squirrel"), TEXT("mouse"),
			TEXT("hedgehog"), TEXT("cat"), TEXT("dog"), TEXT("fox"), TEXT("tortoise"), TEXT("penguin"), TEXT("seal"), TEXT("otter"), TEXT("beaver"), TEXT("marmot"), TEXT("monkey"),
		};
		return Low.Contains(Sp);
	}

	TSharedPtr<FJsonObject> CareObj(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		const TSharedPtr<FJsonObject>* Found = nullptr;
		return Json.IsValid() && Json->TryGetObjectField(Field, Found) ? *Found : TSharedPtr<FJsonObject>();
	}
	FString CareStr(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		FString Out;
		if (Json.IsValid())
		{
			Json->TryGetStringField(Field, Out);
		}
		return Out;
	}

	TSharedRef<STextBlock> CareLine(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Colour, float Wrap = 0.f)
	{
		return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Colour).WrapTextAt(Wrap).Text(FText::FromString(Text));
	}
}

FString UEarthCare::HungerOf(const FString& Sp, uint32 Thing, int64 Day)
{
	const TArray<FString>* Likes = CareWants().Find(Sp);
	if (!Likes)
	{
		return FString();
	}
	const uint32 H = EarthLife::Hash32(Thing, static_cast<uint32>(Day * 131 + 0x48554e47));
	return H % CareOneIn != 0 ? FString() : (*Likes)[(H >> 8) % Likes->Num()];
}

/** The thought bubbles over hungry animals, the bar of a lesson, and the tricks panel. */
class SEarthCareView : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthCareView) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&)
	{
		SetVisibility(EVisibility::SelfHitTestInvisible);
		ChildSlot
		[
			SNew(SOverlay)
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
			[
				SAssignNew(Panel, SBorder)
				.BorderImage(&PanelBrush)
				.BorderBackgroundColor(CarePanel)
				.Padding(FMargin(26.f, 18.f, 26.f, 20.f))
				.Visibility(EVisibility::Collapsed)
				[
					SNew(SBox).WidthOverride(560.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot().FillWidth(1.f)[CareLine(TEXT("Tricks"), TEXT("Bold"), 24, FLinearColor::White)]
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[CareLine(TEXT("K or Esc to close"), TEXT("Regular"), 10, CareDim)]
						]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
						[
							SNew(SBox).MaxDesiredHeight(520.f)
							[
								SAssignNew(Body, SScrollBox)
							]
						]
					]
				]
			]
		];
	}

	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geo, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		const TSharedRef<FSlateFontMeasure> Measure = FSlateApplication::Get().GetRenderer()->GetFontMeasureService();
		const float Scale = Geo.Scale > 0.f ? Geo.Scale : 1.f;
		const auto Box = [&](int32 L, FVector2f At, FVector2f Size, const FSlateBrush* Brush, const FLinearColor& Tint)
		{
			FSlateDrawElement::MakeBox(Out, L, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(At)), Brush, ESlateDrawEffect::None, Tint);
		};
		const auto Words = [&](int32 L, FVector2f Middle, const FString& String, const FSlateFontInfo& Font, const FLinearColor& Colour)
		{
			const FVector2f Size(Measure->Measure(String, Font));
			FSlateDrawElement::MakeText(Out, L, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(Middle - Size * 0.5f)), String, Font, ESlateDrawEffect::None, Colour);
			return Size;
		};

		// A thought over each hungry animal: what it would like, in a white cloud with two small puffs under it.
		const FSlateFontInfo Thought = FCoreStyle::GetDefaultFontStyle("Bold", 11);
		for (const TPair<FVector2D, FString>& Want : Wants)
		{
			const FVector2f At = FVector2f(Want.Key) / Scale;
			const FVector2f Size(Measure->Measure(Want.Value, Thought));
			Box(Layer, At - FVector2f(Size.X * 0.5f + 11.f, Size.Y + 26.f), Size + FVector2f(22.f, 12.f), &Cloud, FLinearColor::White);
			Box(Layer, At - FVector2f(13.f, 12.f), FVector2f(9.f, 9.f), &Puff, FLinearColor::White);
			Box(Layer, At - FVector2f(4.f, 5.f), FVector2f(6.f, 6.f), &Puff, FLinearColor::White);
			Words(Layer + 1, At - FVector2f(0.f, Size.Y * 0.5f + 20.f), Want.Value, Thought, CareInk);
		}

		// The lesson: paw prints run along a bar towards a ring.
		if (bBar)
		{
			const FVector2f Local = Geo.GetLocalSize();
			const float Wide = 560.f, High = 96.f;
			const FVector2f Corner((Local.X - Wide) * 0.5f, 196.f); // under the place and the news of a stamp
			Box(Layer + 2, Corner, FVector2f(Wide, High), &PanelBrush, CarePanel);
			Words(Layer + 3, Corner + FVector2f(Wide * 0.5f, 16.f), BarTitle, FCoreStyle::GetDefaultFontStyle("Bold", 14), FLinearColor::White);
			const float TrackY = Corner.Y + 46.f;
			Box(Layer + 3, FVector2f(Corner.X + 20.f, TrackY - 2.f), FVector2f(Wide - 40.f, 4.f), &Flat, FLinearColor(1.f, 1.f, 1.f, 0.25f));
			Box(Layer + 3, FVector2f(Corner.X + CareRingAt - 19.f, TrackY - 19.f), FVector2f(38.f, 38.f), &Ring, bFlash ? CareGold : FLinearColor::White);
			Box(Layer + 3, FVector2f(Corner.X + CareRingAt - 15.f, TrackY - 15.f), FVector2f(30.f, 30.f), &Ring, FLinearColor(FColor(30, 38, 52)));
			const double At = (FPlatformTime::Seconds() - BarStart) * 1000.0;
			Out.PushClip(FSlateClippingZone(Geo.MakeChild(FVector2f(Wide - 24.f, High), FSlateLayoutTransform(Corner + FVector2f(12.f, 0.f)))));
			for (int32 i = 0; i < BarBeats.Num(); ++i)
			{
				const float X = Corner.X + CareRingAt + static_cast<float>(BarBeats[i] - At) * CareRun;
				const int32 Mark = BarMarks.IsValidIndex(i) ? BarMarks[i] : 0;
				const FLinearColor Colour = Mark == 1 ? FLinearColor(FColor(64, 200, 96)) : Mark == 2 ? FLinearColor(FColor(150, 150, 160)) : FLinearColor(FColor(255, 253, 244));
				// A paw print: a pad and three toes.
				Box(Layer + 4, FVector2f(X - 9.f, TrackY - 5.f), FVector2f(18.f, 15.f), &Pad, Colour);
				for (const float Toe : { -8.f, 0.f, 8.f })
				{
					Box(Layer + 4, FVector2f(X + Toe - 3.5f, TrackY - (Toe == 0.f ? 15.f : 12.f)), FVector2f(7.f, 7.f), &Puff, Colour);
				}
			}
			Out.PopClip();
			Words(Layer + 3, Corner + FVector2f(Wide * 0.5f, High - 15.f), BarNote, FCoreStyle::GetDefaultFontStyle("Regular", 11), CareDim);
		}
		return SCompoundWidget::OnPaint(Args, Geo, Culling, Out, Layer + 6, Style, bParentEnabled);
	}

	/** A line of the panel that does something. */
	TSharedRef<SWidget> Row(const FString& Title, const FString& Sub, bool bEnabled, bool bBold, TFunction<void()> Do)
	{
		return SNew(SBox).WidthOverride(272.f)
		[
			SNew(SButton)
			.IsFocusable(false)
			.IsEnabled(bEnabled)
			.ButtonStyle(bBold ? &NextButton : &RowButton)
			.ContentPadding(FMargin(12.f, 7.f))
			.OnClicked_Lambda([Do]()
			{
				Do();
				return FReply::Handled();
			})
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[CareLine(Title, TEXT("Bold"), 13, bEnabled ? FLinearColor::White : CareDim)]
				+ SVerticalBox::Slot().AutoHeight()[CareLine(Sub, TEXT("Regular"), 10, bBold ? CareGold : CareDim)]
			]
		];
	}

	TArray<TPair<FVector2D, FString>> Wants; // where on the screen each thought goes, and what it says
	bool bBar = false;
	bool bFlash = false;
	FString BarTitle;
	FString BarNote;
	TArray<double> BarBeats;
	TArray<int32> BarMarks; // 0 still to come, 1 met, 2 missed
	double BarStart = 0.0;
	TSharedPtr<SBorder> Panel;
	TSharedPtr<SScrollBox> Body;

	FSlateRoundedBoxBrush PanelBrush = FSlateRoundedBoxBrush(FLinearColor::White, 12.f);
	FSlateRoundedBoxBrush Flat = FSlateRoundedBoxBrush(FLinearColor::White, 2.f);
	FSlateRoundedBoxBrush Cloud = FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 245)), 12.f, CareInk, 2.f);
	FSlateRoundedBoxBrush Puff = FSlateRoundedBoxBrush(FLinearColor::White, 4.f, CareInk, 1.5f);
	FSlateRoundedBoxBrush Pad = FSlateRoundedBoxBrush(FLinearColor::White, 7.f, CareInk, 1.5f);
	FSlateRoundedBoxBrush Ring = FSlateRoundedBoxBrush(FLinearColor::White, 19.f); // a white disc with a dark one on it makes the ring
	FButtonStyle RowButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 16)), 8.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 8)), 8.f));
	// What can be done next: a gold line round it.
	FButtonStyle NextButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 30)), 8.f, CareGold, 1.5f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f, CareGold, 1.5f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f, CareGold, 1.5f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 8)), 8.f));
};

UEarthWalkNet* UEarthCare::Room() const
{
	const AEarthWalkHUD* Screen = Hud.Get();
	return Screen && Screen->GetGameInstance() ? Screen->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
}

void UEarthCare::Say(const FString& Text) const
{
	if (AEarthWalkHUD* Screen = Hud.Get())
	{
		Screen->AddLine(Text, FLinearColor(0.75f, 0.9f, 1.f));
	}
}

/** A lesson is had standing still, and Space is for the lesson: the same switch as typing in the chat box. */
void UEarthCare::HoldStill(bool bHold) const
{
	const AEarthWalkHUD* Screen = Hud.Get();
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	if (AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
	{
		Me->bTyping = bHold;
	}
}

void UEarthCare::Setup(AEarthWalkHUD* InHud)
{
	if (!InHud || !GEngine || !GEngine->GameViewport)
	{
		return;
	}
	Hud = InHud;
	SAssignNew(View, SEarthCareView);
	GEngine->GameViewport->AddViewportWidgetContent(View.ToSharedRef(), 10);
	if (UEarthWalkNet* Net = Room())
	{
		JournalHandle = Net->OnJournal.AddWeakLambda(this, [this](const TSharedPtr<FJsonObject>& InJournal)
		{
			if (!InJournal.IsValid())
			{
				return;
			}
			Journal = InJournal;
			Fed.Reset();
			TArray<FString> Today;
			if (const TSharedPtr<FJsonObject> Care = CareObj(Journal, TEXT("care")); Care.IsValid() && Care->TryGetStringArrayField(TEXT("today"), Today))
			{
				Fed.Append(Today);
			}
			if (bOpen)
			{
				Redraw();
			}
		});
		LessonHandle = Net->OnLesson.AddWeakLambda(this, [this](const FEarthLesson& Lesson)
		{
			if (Lesson.bDone)
			{
				Marked(Lesson);
			}
			else
			{
				Begin(Lesson);
			}
		});
		StampHandle = Net->OnStamp.AddWeakLambda(this, [this](const FString& Kind, const FString&, const FString&)
		{
			if (Kind == TEXT("trick") && bOpen)
			{
				if (UEarthWalkNet* Now = Room())
				{
					Now->RequestJournal();
				}
			}
		});
	}
}

void UEarthCare::Shutdown()
{
	if (UEarthWalkNet* Net = Room())
	{
		Net->OnJournal.Remove(JournalHandle);
		Net->OnLesson.Remove(LessonHandle);
		Net->OnStamp.Remove(StampHandle);
	}
	if (View.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(View.ToSharedRef());
	}
	View.Reset();
	Journal.Reset();
}

void UEarthCare::Toggle()
{
	if (bOpen)
	{
		Close();
		return;
	}
	if (!View.IsValid() || bLesson)
	{
		return;
	}
	bOpen = true;
	View->Panel->SetVisibility(EVisibility::Visible);
	if (UEarthWalkNet* Net = Room())
	{
		Net->RequestJournal();
	}
	Redraw();
}

void UEarthCare::Close()
{
	bOpen = false;
	if (View.IsValid())
	{
		View->Panel->SetVisibility(EVisibility::Collapsed);
	}
}

void UEarthCare::Teach()
{
	UEarthWalkNet* Net = Room();
	const TSharedPtr<FJsonObject> Tricks = CareObj(Journal, TEXT("tricks"));
	if (!Net || bLesson)
	{
		return;
	}
	if (!Tricks.IsValid())
	{
		Net->RequestJournal();
		Say(TEXT("One moment... press K and try again."));
		return;
	}
	if (CareStr(Tricks, TEXT("pet")).IsEmpty())
	{
		Say(TEXT("You have no companion with you. Solve a riddle to win one, and choose it in your passport (P)."));
		return;
	}
	const FString Next = CareStr(Tricks, TEXT("next"));
	if (Next.IsEmpty())
	{
		Say(TEXT("Your companion knows every trick there is."));
		return;
	}
	Net->SendTrick(TEXT("learn"), Next);
}

bool UEarthCare::Perform(const FString& Which)
{
	UEarthWalkNet* Net = Room();
	const TArray<TSharedPtr<FJsonValue>>* All = nullptr;
	if (const TSharedPtr<FJsonObject> Tricks = CareObj(Journal, TEXT("tricks")); Net && Tricks.IsValid() && Tricks->TryGetArrayField(TEXT("all"), All))
	{
		for (const TSharedPtr<FJsonValue>& Value : *All)
		{
			const TSharedPtr<FJsonObject>* Trick = nullptr;
			bool bKnown = false;
			if (Value.IsValid() && Value->TryGetObject(Trick) && (*Trick)->TryGetBoolField(TEXT("known"), bKnown) && bKnown
				&& (CareStr(*Trick, TEXT("id")).Equals(Which, ESearchCase::IgnoreCase) || CareStr(*Trick, TEXT("name")).Equals(Which, ESearchCase::IgnoreCase)))
			{
				Net->SendTrick(TEXT("do"), CareStr(*Trick, TEXT("id")));
				return true;
			}
		}
	}
	return false;
}

void UEarthCare::Agility()
{
	Close();
	if (UEarthWalkNet* Net = Room())
	{
		if (!Net->GetMyPet().bOn)
		{
			Say(TEXT("An agility course is run with a companion at your heels. Solve a riddle to win one, and choose it in your passport (P)."));
			return;
		}
		Say(TEXT("Setting up an agility course before you..."));
		Net->SendAgility();
	}
}

/** The server has set a lesson: the paw prints start running. */
void UEarthCare::Begin(const FEarthLesson& Set)
{
	if (!View.IsValid() || Set.Beats.Num() == 0)
	{
		return;
	}
	Close();
	bLesson = true;
	bHandedIn = false;
	LessonName = Set.Name;
	Beats = Set.Beats;
	Slack = Set.Slack;
	LessonStart = FPlatformTime::Seconds();
	Presses.Reset();
	View->bBar = true;
	View->BarTitle = FString::Printf(TEXT("Teaching: %s"), *Set.Name);
	View->BarNote = TEXT("Press Space each time a paw print reaches the ring");
	View->BarBeats = Beats;
	View->BarMarks.Init(0, Beats.Num());
	View->BarStart = LessonStart;
	HoldStill(true);
}

/** Space, during a lesson. */
void UEarthCare::Press()
{
	const double At = (FPlatformTime::Seconds() - LessonStart) * 1000.0;
	Presses.Add(FMath::RoundToInt32(At));
	// Show at once whether it was on a beat (the server has the last word).
	for (int32 i = 0; i < Beats.Num(); ++i)
	{
		if (View->BarMarks[i] == 0 && FMath::Abs(Beats[i] - At) <= Slack)
		{
			View->BarMarks[i] = 1;
			break;
		}
	}
}

/** The server's marks. */
void UEarthCare::Marked(const FEarthLesson& Result)
{
	bLesson = false;
	if (View.IsValid())
	{
		View->bBar = false;
	}
	HoldStill(false);
	Say(Result.bPassed
		? FString::Printf(TEXT("%s: %d of %d on the beat. Learnt! Press K and it will do it whenever you like."), *Result.Name, Result.Hits, Result.Of)
		: FString::Printf(TEXT("%s: %d of %d on the beat. Nearly! Press K and teach it again: nothing is lost."), *Result.Name, Result.Hits, Result.Of));
	if (UEarthWalkNet* Net = Room())
	{
		Net->RequestJournal();
	}
}

void UEarthCare::Frame(float DeltaSeconds)
{
	UEarthWalkNet* Net = Room();
	const AEarthWalkHUD* Screen = Hud.Get();
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	const AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const AEarthWorld* Earth = Screen ? AEarthWorld::Get(Screen) : nullptr;
	if (!Net || !Me || !Earth || !View.IsValid())
	{
		return;
	}

	// ---- the lesson under way
	if (bLesson)
	{
		const double At = (FPlatformTime::Seconds() - LessonStart) * 1000.0;
		View->bFlash = false;
		if (!bHandedIn)
		{
			if (PC->WasInputKeyJustPressed(EKeys::SpaceBar))
			{
				Press();
				View->bFlash = true;
			}
			// -EWLesson presses for the player, on every beat but the last (one slip is forgiven), for tests.
			static const bool bSelf = FParse::Param(FCommandLine::Get(), TEXT("EWLesson"));
			for (int32 i = 0; i < Beats.Num(); ++i)
			{
				if (bSelf && i + 1 < Beats.Num() && View->BarMarks[i] == 0 && At >= Beats[i])
				{
					Press();
				}
				if (View->BarMarks[i] == 0 && At > Beats[i] + Slack)
				{
					View->BarMarks[i] = 2;
				}
			}
			if (At > Beats.Last() + CareAfterMs)
			{
				bHandedIn = true;
				BarUntil = FPlatformTime::Seconds() + 8.0;
				View->BarNote = TEXT("Let us see how that went...");
				Net->SendTrickPresses(Presses);
			}
		}
		else if (FPlatformTime::Seconds() > BarUntil)
		{
			// No marks came (the connection dropped, say): let the player go.
			bLesson = false;
			View->bBar = false;
			HoldStill(false);
		}
	}

	// ---- a companion leaps as its runner comes to a jump on an agility course
	{
		static TMap<FString, int32> Reached;
		const FEarthRace& Race = Net->GetRace();
		UEarthCompany* Company = Earth->GetCompany();
		if (Race.bOn && Race.Kind == TEXT("agility") && Company)
		{
			for (const FEarthRunner& Runner : Race.Runners)
			{
				const int32* Before = Reached.Find(Runner.Id);
				if (Before && Runner.Gate > *Before && Race.Obstacles.IsValidIndex(Runner.Gate - 1))
				{
					const FString& What = Race.Obstacles[Runner.Gate - 1];
					if (What == TEXT("jump") || What == TEXT("hoop") || What == TEXT("table"))
					{
						Company->Hop(Runner.Id);
					}
				}
				Reached.Add(Runner.Id, Runner.Gate);
			}
		}
		else
		{
			Reached.Reset();
		}
	}

	// ---- thoughts over the hungry animals near here
	const AEarthLife* Life = Earth->GetLife();
	const FVector Here = Me->GetActorLocation();
	const double Px = Here.Y / 100.0, Pz = -Here.X / 100.0;
	const int64 TzMinutes = FMath::RoundToInt64((FDateTime::Now() - FDateTime::UtcNow()).GetTotalMinutes());
	const int64 Day = FMath::FloorToInt64((Net->Now() * 1000.0 + TzMinutes * 60000.0) / 86400000.0);
	View->Wants.Reset();
	FString NearWant;
	double NearD = CareNearM;
	if (Life && !Me->IsWaitingForGround())
	{
		for (const FEarthThing& Animal : Life->GetNearby())
		{
			// -EWHungry makes every animal that is ever hungry hungry today, for pictures.
			static const bool bAll = FParse::Param(FCommandLine::Get(), TEXT("EWHungry"));
			const TArray<FString>* Likes = bAll ? CareWants().Find(Animal.Sp) : nullptr;
			const FString Want = Likes ? (*Likes)[0] : HungerOf(Animal.Sp, Animal.Thing, Day);
			if (Want.IsEmpty() || Fed.Contains(FString::Printf(TEXT("%s:%u"), *Animal.Sp, Animal.Thing)))
			{
				continue;
			}
			const double D = FMath::Sqrt(FMath::Square(Animal.X - Px) + FMath::Square(Animal.Z - Pz));
			if (D > CareSeeM)
			{
				continue;
			}
			if (D < NearD)
			{
				NearD = D;
				NearWant = Want;
			}
			double Ground = 0.0;
			if (View->Wants.Num() >= CareMost || !Earth->TerrainHeightAt(Animal.X, Animal.Z, Ground))
			{
				continue;
			}
			const FEarthMount* Mount = EarthMounts::Find(Animal.Sp);
			const double Up = CareIsLow(Animal.Sp) ? 0.8 : (Mount ? Mount->Seat : 1.2) + 0.45; // the cloud is drawn above this spot
			FVector2D At;
			if (PC->ProjectWorldLocationToScreen(FVector(-Animal.Z * 100.0, Animal.X * 100.0, (Ground + Up) * 100.0), At, false))
			{
				View->Wants.Emplace(At, CareFoodName(Want));
			}
		}
	}
	Hint = NearWant.IsEmpty() ? FString() : FString::Printf(TEXT("It is hungry for %s: T to talk"), *CareFoodName(NearWant));
}

void UEarthCare::Redraw()
{
	if (!View.IsValid())
	{
		return;
	}
	const TSharedPtr<SScrollBox> Body = View->Body;
	Body->ClearChildren();
	const auto Note = [&Body](const FString& Text)
	{
		Body->AddSlot().Padding(2.f, 2.f, 0.f, 6.f)[CareLine(Text, TEXT("Regular"), 11, CareDim, 540.f)];
	};
	const TSharedPtr<FJsonObject> Tricks = CareObj(Journal, TEXT("tricks"));
	if (!Tricks.IsValid())
	{
		Note(TEXT("One moment..."));
		return;
	}
	const FString Pet = CareStr(Tricks, TEXT("pet"));
	if (Pet.IsEmpty())
	{
		Note(TEXT("You have no companion with you. Solve a riddle (P, Riddles) to win an animal that follows you about, and choose it under Companions. Then it can learn tricks."));
		return;
	}
	const FString Next = CareStr(Tricks, TEXT("next"));
	double Coins = 0.0;
	Tricks->TryGetNumberField(TEXT("coins"), Coins);
	const TArray<TSharedPtr<FJsonValue>>* All = nullptr;
	Tricks->TryGetArrayField(TEXT("all"), All);
	int32 Known = 0, Total = 0;
	const TWeakObjectPtr<UEarthCare> Self = this;
	const TSharedRef<SWrapBox> List = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(8.0, 8.0));
	for (const TSharedPtr<FJsonValue>& Value : All ? *All : TArray<TSharedPtr<FJsonValue>>())
	{
		const TSharedPtr<FJsonObject>* Trick = nullptr;
		if (!Value.IsValid() || !Value->TryGetObject(Trick))
		{
			continue;
		}
		const FString Id = CareStr(*Trick, TEXT("id"));
		bool bKnown = false;
		(*Trick)->TryGetBoolField(TEXT("known"), bKnown);
		const bool bNext = Id == Next;
		++Total;
		Known += bKnown ? 1 : 0;
		List->AddSlot()[View->Row(CareStr(*Trick, TEXT("name")), bKnown ? FString(TEXT("Do it")) : bNext ? FString::Printf(TEXT("Teach it  ·  %d coins when learnt"), FMath::RoundToInt32(Coins)) : FString(TEXT("Later")),
			bKnown || bNext, bNext && !bKnown, [Self, Id, bKnown]()
		{
			if (UEarthCare* Care = Self.Get())
			{
				if (bKnown)
				{
					Care->Perform(Id);
				}
				else
				{
					Care->Teach();
				}
			}
		})];
	}
	Note(FString::Printf(TEXT("Your %s knows %d of %d tricks. Friends nearby see it do them."), *Pet, Known, Total));
	double Best = 0.0;
	const bool bBest = CareObj(Journal, TEXT("agility")).IsValid() && CareObj(Journal, TEXT("agility"))->TryGetNumberField(TEXT("bestSeconds"), Best);
	List->AddSlot()[View->Row(TEXT("Agility course"), bBest ? FString::Printf(TEXT("Set one up here  ·  best %.1f s"), Best) : FString(TEXT("Set one up here")), true, false, [Self]()
	{
		if (UEarthCare* Care = Self.Get())
		{
			Care->Agility();
		}
	})];
	Body->AddSlot()[List];
	Note(TEXT("A lesson is a game of timing: press Space as each paw print reaches the ring. One slip is forgiven."));
}
