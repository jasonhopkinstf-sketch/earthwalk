#include "EarthHome.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Dom/JsonObject.h"
#include "EarthCompany.h"
#include "EarthFilePick.h"
#include "EarthWalkSettings.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Misc/CommandLine.h"
#include "Misc/FileHelper.h"
#include "Misc/Parse.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Widgets/SLeafWidget.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWalkNet.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Fonts/FontMeasure.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
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
	/** How near my own front door counts as "at the door" (the panel opens there too), and as "at home" for the kitchen: metres. As houses.js and the server. */
	constexpr double HomeDoorM = 18.0;
	constexpr double HomeKitchenM = 40.0;
	/** A name is put over the door of a house this near. */
	constexpr double HomeTagM = 90.0;

	const FLinearColor HomePanel(FColor(22, 28, 38, 240));
	const FLinearColor HomeDim(1.f, 1.f, 1.f, 0.62f);
	const FLinearColor HomeGold(FColor(245, 197, 24));
	const FLinearColor HomeInk(FColor(38, 34, 31));

	/** The parts of a house that can be swapped, in the order the panel shows them. */
	const struct FHomeSlot { const TCHAR* Slot; const TCHAR* Title; const TCHAR* Plain; } HomeSlots[] = {
		{ TEXT("walls"), TEXT("Walls"), TEXT("As the house came") },
		{ TEXT("floor"), TEXT("Floors"), TEXT("As the house came") },
		{ TEXT("sofa"), TEXT("Sofa"), TEXT("The sofa it came with") },
		{ TEXT("bed"), TEXT("Beds"), TEXT("The beds it came with") },
		{ TEXT("rug"), TEXT("Rugs"), TEXT("The rugs it came with") },
	};

	/** "Sam's house"; "Jess' house". */
	FString HomeDoorName(const FString& Name)
	{
		return Name.EndsWith(TEXT("s"), ESearchCase::IgnoreCase) ? Name + TEXT("' house") : Name + TEXT("'s house");
	}

	FString HomeStr(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		FString Out;
		if (Json.IsValid())
		{
			Json->TryGetStringField(Field, Out);
		}
		return Out;
	}
	double HomeNum(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		double Out = 0.0;
		if (Json.IsValid())
		{
			Json->TryGetNumberField(Field, Out);
		}
		return Out;
	}
	TSharedPtr<FJsonObject> HomeObj(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		const TSharedPtr<FJsonObject>* Found = nullptr;
		return Json.IsValid() && Json->TryGetObjectField(Field, Found) ? *Found : TSharedPtr<FJsonObject>();
	}
	TArray<TSharedPtr<FJsonObject>> HomeRows(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
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

	TSharedRef<STextBlock> HomeLine(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Colour, float Wrap = 0.f)
	{
		return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Colour).WrapTextAt(Wrap).Text(FText::FromString(Text));
	}
}

/**
 * A plan drawn small, a floor beside a floor, as seen from above with the front door at the bottom
 * (drawPlan in server/public/js/decor.js): each room in the colour of its kind with its name, the
 * stairs with their treads, the front door in red.
 */
class SEarthPlanView : public SLeafWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthPlanView) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, const TSharedPtr<FJsonObject>& Plan)
	{
		static const TMap<FString, FColor> Hex = {
			{ TEXT("L"), FColor(0xe9, 0xd9, 0xb5) }, { TEXT("K"), FColor(0xd9, 0xe6, 0xea) }, { TEXT("B"), FColor(0xd7, 0xe3, 0xf2) }, { TEXT("T"), FColor(0xcf, 0xe6, 0xdd) }, { TEXT("H"), FColor(0xef, 0xe6, 0xcf) },
			{ TEXT("D"), FColor(0xf0, 0xdc, 0xc6) }, { TEXT("S"), FColor(0xe3, 0xdc, 0xef) }, { TEXT("P"), FColor(0xf3, 0xe2, 0xea) }, { TEXT("U"), FColor(0xde, 0xde, 0xde) },
		};
		const TArray<TSharedPtr<FJsonValue>>* Floors = nullptr;
		if (!Plan.IsValid() || !Plan->TryGetArrayField(TEXT("floors"), Floors))
		{
			return;
		}
		double A0 = 1e9, A1 = -1e9, B0 = 1e9, B1 = -1e9;
		for (int32 n = 0; n < Floors->Num(); ++n)
		{
			const TSharedPtr<FJsonObject>* Floor = nullptr;
			const TArray<TSharedPtr<FJsonValue>>* Rooms = nullptr;
			if (!(*Floors)[n]->TryGetObject(Floor) || !(*Floor)->TryGetArrayField(TEXT("rooms"), Rooms))
			{
				continue;
			}
			for (const TSharedPtr<FJsonValue>& Value : *Rooms)
			{
				const TSharedPtr<FJsonObject>* Room = nullptr;
				if (!Value->TryGetObject(Room))
				{
					continue;
				}
				FPart& Part = Parts.AddDefaulted_GetRef();
				Part.Floor = n;
				Part.A0 = (*Room)->GetNumberField(TEXT("a0"));
				Part.A1 = (*Room)->GetNumberField(TEXT("a1"));
				Part.B0 = (*Room)->GetNumberField(TEXT("b0"));
				Part.B1 = (*Room)->GetNumberField(TEXT("b1"));
				Part.Name = (*Room)->GetStringField(TEXT("name"));
				if (Part.Name.Len() > 14)
				{
					Part.Name = Part.Name.Left(13) + TEXT("…");
				}
				const FColor* Colour = Hex.Find((*Room)->GetStringField(TEXT("kind")));
				Part.Colour = FLinearColor(Colour ? *Colour : FColor(0xee, 0xee, 0xee));
				A0 = FMath::Min(A0, Part.A0);
				A1 = FMath::Max(A1, Part.A1);
				B0 = FMath::Min(B0, Part.B0);
				B1 = FMath::Max(B1, Part.B1);
			}
		}
		NumFloors = Floors->Num();
		if (Parts.Num() == 0 || NumFloors == 0 || A1 - A0 < 0.1 || B1 - B0 < 0.1)
		{
			Parts.Reset();
			return;
		}
		const TSharedPtr<FJsonObject>* Up = nullptr;
		if (Plan->TryGetObjectField(TEXT("stairs"), Up))
		{
			bStairs = true;
			Stairs.A0 = (*Up)->GetNumberField(TEXT("a0"));
			Stairs.A1 = (*Up)->GetNumberField(TEXT("a1"));
			Stairs.B0 = (*Up)->GetNumberField(TEXT("b0"));
			Stairs.B1 = (*Up)->GetNumberField(TEXT("b1"));
			bAlongB = (*Up)->GetStringField(TEXT("along")) == TEXT("b");
		}
		Left = A0;
		Top = B1;
		K = FMath::Min(26.0, (340.0 - Pad * 2.0 - Gap * (NumFloors - 1)) / ((A1 - A0) * NumFloors));
		Wide = (A1 - A0) * K;
		High = (B1 - B0) * K;
		Size = FVector2D(Pad * 2.0 + Wide * NumFloors + Gap * (NumFloors - 1), Pad * 2.0 + High + 16.0);
	}

	virtual FVector2D ComputeDesiredSize(float) const override
	{
		return Size;
	}

	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geo, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		if (Parts.Num() == 0)
		{
			return Layer;
		}
		const FSlateBrush* White = FCoreStyle::Get().GetBrush("WhiteBrush");
		const TSharedRef<FSlateFontMeasure> Measure = FSlateApplication::Get().GetRenderer()->GetFontMeasureService();
		const FLinearColor Ink(FColor(0x2b, 0x26, 0x20)), Wood(FColor(0x5a, 0x3a, 0x24));
		const auto Fill = [&](int32 At, double X, double Y, double W, double H, const FLinearColor& Colour)
		{
			FSlateDrawElement::MakeBox(Out, At, Geo.ToPaintGeometry(FVector2f(W, H), FSlateLayoutTransform(FVector2f(X, Y))), White, ESlateDrawEffect::None, Colour);
		};
		const auto Line = [&](int32 At, double X0, double Y0, double X1, double Y1, const FLinearColor& Colour)
		{
			FSlateDrawElement::MakeLines(Out, At, Geo.ToPaintGeometry(), TArray<FVector2f>{ FVector2f(X0, Y0), FVector2f(X1, Y1) }, ESlateDrawEffect::None, Colour, true, 1.5f);
		};
		const auto Words = [&](int32 At, const FString& Text, const FSlateFontInfo& Font, double MidX, double MidY, const FLinearColor& Colour)
		{
			const FVector2f Took(Measure->Measure(Text, Font));
			FSlateDrawElement::MakeText(Out, At, Geo.ToPaintGeometry(Took, FSlateLayoutTransform(FVector2f(MidX - Took.X * 0.5f, MidY - Took.Y * 0.5f))), Text, Font, ESlateDrawEffect::None, Colour);
		};
		Fill(Layer, 0.0, 0.0, Size.X, Size.Y, FLinearColor(FColor(0xff, 0xfa, 0xf0)));
		for (int32 n = 0; n < NumFloors; ++n)
		{
			const double Off = Pad + n * (Wide + Gap);
			const auto X = [&](double A) { return Off + (A - Left) * K; };
			const auto Y = [&](double B) { return Pad + (Top - B) * K; }; // into the house is up the page
			for (const FPart& Part : Parts)
			{
				if (Part.Floor != n)
				{
					continue;
				}
				const double W = (Part.A1 - Part.A0) * K, H = (Part.B1 - Part.B0) * K;
				Fill(Layer + 1, X(Part.A0), Y(Part.B1), W, H, Part.Colour);
				FSlateDrawElement::MakeLines(Out, Layer + 2, Geo.ToPaintGeometry(), TArray<FVector2f>{ FVector2f(X(Part.A0), Y(Part.B1)), FVector2f(X(Part.A1), Y(Part.B1)), FVector2f(X(Part.A1), Y(Part.B0)), FVector2f(X(Part.A0), Y(Part.B0)), FVector2f(X(Part.A0), Y(Part.B1)) },
					ESlateDrawEffect::None, Ink, true, 1.5f);
				Words(Layer + 4, Part.Name, FCoreStyle::GetDefaultFontStyle("Regular", FMath::Clamp(FMath::FloorToInt32(W / 9.0), 6, 8)), X((Part.A0 + Part.A1) / 2.0), Y((Part.B0 + Part.B1) / 2.0), Ink);
			}
			if (bStairs)
			{
				Fill(Layer + 3, X(Stairs.A0), Y(Stairs.B1), (Stairs.A1 - Stairs.A0) * K, (Stairs.B1 - Stairs.B0) * K, FLinearColor(FColor(138, 90, 58)).CopyWithNewOpacity(0.55f));
				for (int32 i = 1; i < 7; ++i)
				{
					if (bAlongB)
					{
						const double B = Stairs.B0 + ((Stairs.B1 - Stairs.B0) * i) / 7.0;
						Line(Layer + 4, X(Stairs.A0), Y(B), X(Stairs.A1), Y(B), Wood);
					}
					else
					{
						const double A = Stairs.A0 + ((Stairs.A1 - Stairs.A0) * i) / 7.0;
						Line(Layer + 4, X(A), Y(Stairs.B0), X(A), Y(Stairs.B1), Wood);
					}
				}
			}
			if (n == 0)
			{
				Fill(Layer + 4, X(-0.45), Y(0.0) - 2.0, 0.9 * K, 5.0, FLinearColor(FColor(0xb5, 0x37, 0x2e))); // the front door, in the front wall of the room behind it
			}
			Words(Layer + 4, NumFloors == 1 ? TEXT("front door at the bottom, in red") : n == 0 ? TEXT("ground floor (door in red)") : TEXT("upstairs"), FCoreStyle::GetDefaultFontStyle("Regular", 7), Off + Wide / 2.0, Pad + High + 9.0,
				FLinearColor(FColor(0x6b, 0x5d, 0x45)));
		}
		return Layer + 4;
	}

private:
	struct FPart
	{
		int32 Floor = 0;
		double A0 = 0.0, A1 = 0.0, B0 = 0.0, B1 = 0.0;
		FLinearColor Colour;
		FString Name;
	};
	static constexpr double Pad = 10.0, Gap = 14.0;
	TArray<FPart> Parts;
	FPart Stairs;
	bool bStairs = false;
	bool bAlongB = false;
	int32 NumFloors = 0;
	double Left = 0.0, Top = 0.0, K = 1.0, Wide = 0.0, High = 0.0;
	FVector2D Size = FVector2D::ZeroVector;
};

/** The names over the doors of houses that are lived in, and the furnishing panel in the middle of the screen. */
class SEarthHomeView : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthHomeView) {}
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
				.BorderBackgroundColor(HomePanel)
				.Padding(FMargin(26.f, 18.f, 26.f, 20.f))
				.Visibility(EVisibility::Collapsed)
				[
					SNew(SBox).WidthOverride(660.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot().FillWidth(1.f)[HomeLine(TEXT("Your house"), TEXT("Bold"), 24, FLinearColor::White)]
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[HomeLine(TEXT("H or Esc to close"), TEXT("Regular"), 10, HomeDim)]
						]
						+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 6.f, 0.f, 0.f)
						[
							SNew(SBox).MaxDesiredHeight(540.f)
							[
								SAssignNew(Body, SScrollBox)
							]
						]
					]
				]
			]
		];
	}

	/** The names over the doors, drawn after everything else of this widget: each a cream board with its words in ink. */
	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geo, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		// The names first, so that the panel is over them.
		const TSharedRef<FSlateFontMeasure> Measure = FSlateApplication::Get().GetRenderer()->GetFontMeasureService();
		const FSlateFontInfo Font = FCoreStyle::GetDefaultFontStyle("Bold", 13);
		const float Scale = Geo.Scale > 0.f ? Geo.Scale : 1.f;
		for (const TPair<FVector2D, FString>& Name : Tags)
		{
			const FVector2f Size(Measure->Measure(Name.Value, Font));
			const FVector2f At = FVector2f(Name.Key) / Scale - FVector2f(Size.X * 0.5f, Size.Y);
			FSlateDrawElement::MakeBox(Out, Layer, Geo.ToPaintGeometry(Size + FVector2f(18.f, 8.f), FSlateLayoutTransform(At - FVector2f(9.f, 4.f))), &Board, ESlateDrawEffect::None, FLinearColor::White);
			FSlateDrawElement::MakeText(Out, Layer + 1, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(At)), Name.Value, Font, ESlateDrawEffect::None, HomeInk);
		}
		return SCompoundWidget::OnPaint(Args, Geo, Culling, Out, Layer + 2, Style, bParentEnabled);
	}

	/** A round-cornered square of each of a piece's colours, side by side. */
	TSharedRef<SWidget> Swatch(const TArray<FColor>& Colours)
	{
		const TSharedRef<SHorizontalBox> Row = SNew(SHorizontalBox);
		for (const FColor& Colour : Colours)
		{
			Row->AddSlot().AutoWidth()
			[
				SNew(SBox).WidthOverride(Colours.Num() > 1 ? 11.f : 22.f).HeightOverride(22.f)
				[
					SNew(SBorder).BorderImage(&Chip).BorderBackgroundColor(FLinearColor(Colour))
				]
			];
		}
		if (Colours.Num() == 0)
		{
			Row->AddSlot().AutoWidth()[SNew(SBox).WidthOverride(22.f).HeightOverride(22.f)[SNew(SBorder).BorderImage(&Chip).BorderBackgroundColor(FLinearColor(1.f, 1.f, 1.f, 0.18f))]];
		}
		return Row;
	}

	/** A piece to choose: its colours, its name, and a few words on where it stands with its owner. */
	TSharedRef<SWidget> Card(const TArray<FColor>& Colours, const FString& Name, const FString& Note, bool bOn, bool bEnabled, TFunction<void()> Do)
	{
		return SNew(SBox).WidthOverride(212.f)
		[
			SNew(SButton)
			.IsFocusable(false)
			.IsEnabled(bEnabled)
			.ButtonStyle(bOn ? &OnButton : &RowButton)
			.ContentPadding(FMargin(8.f, 6.f))
			.OnClicked_Lambda([Do]()
			{
				Do();
				return FReply::Handled();
			})
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 8.f, 0.f)[Swatch(Colours)]
				+ SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()[HomeLine(Name, TEXT("Bold"), 11, bEnabled ? FLinearColor::White : HomeDim, 160.f)]
					+ SVerticalBox::Slot().AutoHeight()[HomeLine(Note, TEXT("Regular"), 9, bOn ? HomeGold : HomeDim, 160.f)]
				]
			]
		];
	}

	/** A small button with a word on it. */
	TSharedRef<SWidget> Small(const FString& Word, bool bEnabled, TFunction<void()> Do)
	{
		return SNew(SButton)
			.IsFocusable(false)
			.IsEnabled(bEnabled)
			.ButtonStyle(&RowButton)
			.ContentPadding(FMargin(9.f, 3.f))
			.OnClicked_Lambda([Do]()
			{
				Do();
				return FReply::Handled();
			})
			[
				HomeLine(Word, TEXT("Bold"), 10, bEnabled ? FLinearColor::White : HomeDim)
			];
	}

	TArray<TPair<FVector2D, FString>> Tags; // where on the screen (in its own dots) each name goes, and the name
	TSharedPtr<SBorder> Panel;
	TSharedPtr<SScrollBox> Body;

	FSlateRoundedBoxBrush PanelBrush = FSlateRoundedBoxBrush(FLinearColor::White, 12.f);
	FSlateRoundedBoxBrush Chip = FSlateRoundedBoxBrush(FLinearColor::White, 4.f);
	FSlateRoundedBoxBrush Board = FSlateRoundedBoxBrush(FLinearColor(FColor(255, 253, 244, 245)), 6.f, HomeInk, 2.f);
	FButtonStyle RowButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 16)), 8.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 8)), 8.f));
	// The piece that is in place: a gold line round it.
	FButtonStyle OnButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 30)), 8.f, HomeGold, 1.5f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f, HomeGold, 1.5f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f, HomeGold, 1.5f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 30)), 8.f, HomeGold, 1.5f));
};

UEarthWalkNet* UEarthHome::Room() const
{
	const AEarthWalkHUD* Screen = Hud.Get();
	return Screen && Screen->GetGameInstance() ? Screen->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
}

FString UEarthHome::MyKey() const
{
	const UEarthWalkNet* Net = Room();
	const TSharedPtr<FJsonObject> Mine = Net ? Net->GetMyHouse() : TSharedPtr<FJsonObject>();
	return Mine.IsValid() ? UEarthWalkNet::HouseKey(static_cast<int64>(HomeNum(Mine, TEXT("x"))), static_cast<int64>(HomeNum(Mine, TEXT("y"))), static_cast<int64>(HomeNum(Mine, TEXT("id")))) : FString();
}

void UEarthHome::Setup(AEarthWalkHUD* InHud)
{
	if (!InHud || !GEngine || !GEngine->GameViewport)
	{
		return;
	}
	Hud = InHud;
	SAssignNew(View, SEarthHomeView);
	GEngine->GameViewport->AddViewportWidgetContent(View.ToSharedRef(), 10);
	if (UEarthWalkNet* Net = Room())
	{
		Had = MyKey();
		JournalHandle = Net->OnJournal.AddWeakLambda(this, [this](const TSharedPtr<FJsonObject>& InJournal)
		{
			if (InJournal.IsValid())
			{
				Journal = InJournal;
				if (bOpen)
				{
					Redraw();
				}
			}
		});
		HouseHandle = Net->OnHouse.AddWeakLambda(this, [this](bool bFromWelcome)
		{
			const FString Now = MyKey();
			AEarthWalkHUD* Screen = Hud.Get();
			if (!bFromWelcome && Now != Had && Screen)
			{
				Screen->AddLine(Now.IsEmpty() ? TEXT("You have moved out. Your furniture and prizes are kept for your next house.")
					: TEXT("This house is yours now, and your name is over the door. Press H in here to furnish it; anywhere else, H brings you home."), FLinearColor(0.75f, 0.9f, 1.f));
			}
			Had = Now;
			if (bOpen)
			{
				Redraw();
			}
		});
		LivedHandle = Net->OnLived.AddWeakLambda(this, [this](const FString& Key, bool)
		{
			// The house I am standing in has been furnished differently, moved into or left: its rooms are built again round me.
			const AEarthWalkHUD* Screen = Hud.Get();
			AEarthWorld* Earth = Screen ? AEarthWorld::Get(Screen) : nullptr;
			if (bInside && Key == InsideKey && Earth)
			{
				Earth->OpenHouse(Inside, [](bool, const FString&) {});
			}
		});
	}
}

void UEarthHome::Shutdown()
{
	if (UEarthWalkNet* Net = Room())
	{
		Net->OnJournal.Remove(JournalHandle);
		Net->OnHouse.Remove(HouseHandle);
		Net->OnLived.Remove(LivedHandle);
	}
	if (View.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(View.ToSharedRef());
	}
	View.Reset();
	Journal.Reset();
}

void UEarthHome::Toggle()
{
	if (bOpen)
	{
		Close();
		return;
	}
	if (!View.IsValid())
	{
		return;
	}
	bOpen = true;
	LeavingUntil = 0.0;
	View->Panel->SetVisibility(EVisibility::Visible);
	if (UEarthWalkNet* Net = Room())
	{
		Net->RequestJournal(); // the catalogue of pieces, and the coins
	}
	Redraw();
}

void UEarthHome::Close()
{
	bOpen = false;
	if (View.IsValid())
	{
		View->Panel->SetVisibility(EVisibility::Collapsed);
	}
}

void UEarthHome::KeyHome()
{
	UEarthWalkNet* Net = Room();
	AEarthWalkHUD* Screen = Hud.Get();
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	const AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	if (!Net || !Screen || !Me)
	{
		return;
	}
	const FLinearColor Notice(0.75f, 0.9f, 1.f);
	const FString Mine = MyKey();
	if (bInside && !Mine.IsEmpty() && InsideKey == Mine)
	{
		Toggle();
		return;
	}
	if (bInside && bInShop)
	{
		Screen->AddLine(TEXT("Nobody can live here: it is not a house. Outside, H takes you home."), Notice);
		return;
	}
	if (bInside)
	{
		if (const FEarthLived* Whose = Net->GetHomes().Find(InsideKey))
		{
			Screen->AddLine(FString::Printf(TEXT("%s: it is theirs to furnish. Yours is a press of H away, once you are outside."), *HomeDoorName(Whose->Name)), Notice);
			return;
		}
		// Moving out of a furnished house wants a second press, so that it cannot happen by accident.
		const double Now = FPlatformTime::Seconds();
		if (!Mine.IsEmpty() && !(SureKey == InsideKey && Now < SureUntil))
		{
			SureKey = InsideKey;
			SureUntil = Now + 8.0;
			Screen->AddLine(TEXT("Move here from your other house? Press H again to move in. Your furniture and prizes come with you."), Notice);
			return;
		}
		SureKey.Reset();
		Screen->AddLine(TEXT("Asking for the keys..."), Notice); // (the first time in a neighbourhood the server may take a few seconds to measure the house)
		const TSharedRef<FJsonObject> Claim = MakeShared<FJsonObject>();
		Claim->SetNumberField(TEXT("x"), static_cast<double>(((Inside.Chunk.X % 65536) + 65536) % 65536));
		Claim->SetNumberField(TEXT("y"), static_cast<double>(Inside.Chunk.Y));
		Claim->SetNumberField(TEXT("id"), static_cast<double>(Inside.Id));
		const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
		Body->SetObjectField(TEXT("claim"), Claim);
		Net->SendHouse(Body);
		return;
	}
	// Just outside my own front door H opens the same panel.
	if (!Mine.IsEmpty() && bAtDoor)
	{
		Toggle();
		return;
	}
	if (Mine.IsEmpty())
	{
		Screen->AddLine(TEXT("You have no house yet. Go into a house nobody lives in (E at a door with a COME IN board) and press H there."), Notice);
		return;
	}
	if (Me->GetMount() || Me->IsCarried())
	{
		Screen->AddLine(TEXT("Hop off first (E), then H takes you home."), Notice);
		return;
	}
	GoHome();
}

/** Travels to my own front door, a few steps outside it. */
void UEarthHome::GoHome()
{
	UEarthWalkNet* Net = Room();
	AEarthWalkHUD* Screen = Hud.Get();
	APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const TSharedPtr<FJsonObject> Mine = Net ? Net->GetMyHouse() : TSharedPtr<FJsonObject>();
	if (!Me || !Mine.IsValid())
	{
		return;
	}
	const double Lat = HomeNum(Mine, TEXT("lat")), Lon = HomeNum(Mine, TEXT("lon")), Yaw = HomeNum(Mine, TEXT("yaw"));
	const double Out = 7.5, Turn = FMath::DegreesToRadians(Yaw); // the way out of the door; far enough back to see the name over it and the garden before it
	Screen->AddLine(TEXT("Going home..."), FLinearColor(0.75f, 0.9f, 1.f));
	Close();
	Me->TeleportToGeo(Lat + (FMath::Cos(Turn) * Out) / 111320.0, Lon + (FMath::Sin(Turn) * Out) / (111320.0 * FMath::Cos(FMath::DegreesToRadians(Lat))));
	PC->SetControlRotation(FRotator(0.0, Yaw + 180.0, 0.0)); // facing the door
	bArriving = true; // a traveller is set down on whatever is highest there, which may be a porch roof: Frame puts them on the ground
}

void UEarthHome::Put(const FString& Slot, const FString& Id)
{
	if (UEarthWalkNet* Net = Room())
	{
		const TSharedRef<FJsonObject> What = MakeShared<FJsonObject>();
		What->SetStringField(TEXT("slot"), Slot);
		if (!Id.IsEmpty())
		{
			What->SetStringField(TEXT("id"), Id);
		}
		const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
		Body->SetObjectField(TEXT("put"), What);
		Net->SendHouse(Body);
	}
}

void UEarthHome::Show(const FString& Id, bool bOn)
{
	if (UEarthWalkNet* Net = Room())
	{
		const TSharedRef<FJsonObject> What = MakeShared<FJsonObject>();
		What->SetStringField(TEXT("slot"), TEXT("prize"));
		What->SetStringField(TEXT("id"), Id);
		What->SetBoolField(TEXT("on"), bOn);
		const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
		Body->SetObjectField(TEXT("put"), What);
		Net->SendHouse(Body);
	}
}

void UEarthHome::Place(const FString& Id, int32 How)
{
	if (UEarthWalkNet* Net = Room())
	{
		const TSharedRef<FJsonObject> What = MakeShared<FJsonObject>();
		What->SetStringField(TEXT("id"), Id);
		if (How == 1)
		{
			What->SetBoolField(TEXT("turn"), true);
		}
		else if (How == 2)
		{
			What->SetBoolField(TEXT("wall"), true);
		}
		const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
		Body->SetObjectField(TEXT("place"), What);
		Net->SendHouse(Body);
	}
}

void UEarthHome::Garden(const FString& Verb, const FString& Sp, int32 Index)
{
	UEarthWalkNet* Net = Room();
	if (!Net)
	{
		return;
	}
	if (Verb == TEXT("release") && !(Parting == Index && FPlatformTime::Seconds() < PartingUntil))
	{
		// Sending one away wants a second click, so that it cannot happen by accident.
		Parting = Index;
		PartingUntil = FPlatformTime::Seconds() + 5.0;
		if (bOpen)
		{
			Redraw();
		}
		return;
	}
	Parting = -1;
	Net->SendGarden(Verb, Sp, Index);
}

void UEarthHome::MoveOut()
{
	UEarthWalkNet* Net = Room();
	if (!Net || !Net->GetMyHouse().IsValid())
	{
		return;
	}
	const double Now = FPlatformTime::Seconds();
	if (Now > LeavingUntil)
	{
		LeavingUntil = Now + 6.0; // a second click within six seconds means it
		Redraw();
		return;
	}
	LeavingUntil = 0.0;
	const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetBoolField(TEXT("leave"), true);
	Net->SendHouse(Body);
	Close();
}

void UEarthHome::ChoosePlan()
{
	UEarthWalkNet* Net = Room();
	AEarthWalkHUD* Screen = Hud.Get();
	if (!Net || !Screen || bReadingPlan)
	{
		return;
	}
	const FLinearColor Notice(0.75f, 0.9f, 1.f);
	if (!Net->GetMyHouse().IsValid())
	{
		Screen->AddLine(TEXT("You need a house of your own first: go into a house nobody lives in and press H."), Notice);
		return;
	}
	if (!Net->IsSignedIn())
	{
		Screen->AddLine(TEXT("Uploading a plan is for people signed in with their own account."), Notice);
		return;
	}
	// (-EWPlanFile=<file> names the picture, for a test with nobody there to choose one.)
	FString File;
	if (!FParse::Value(FCommandLine::Get(), TEXT("-EWPlanFile="), File) || File.IsEmpty())
	{
		if (!EarthPickFile(TEXT("Choose a picture of a floor plan"), TEXT("Pictures and PDFs|*.png;*.jpg;*.jpeg;*.webp;*.gif;*.pdf|All files|*.*"), File))
		{
			return;
		}
	}
	UploadPlan(File);
}

void UEarthHome::UploadPlan(const FString& File)
{
	static const TMap<FString, FString> Media = {
		{ TEXT("png"), TEXT("image/png") }, { TEXT("jpg"), TEXT("image/jpeg") }, { TEXT("jpeg"), TEXT("image/jpeg") }, { TEXT("webp"), TEXT("image/webp") }, { TEXT("gif"), TEXT("image/gif") }, { TEXT("pdf"), TEXT("application/pdf") },
	};
	PlanRead.Reset();
	const FString* Type = Media.Find(FPaths::GetExtension(File).ToLower());
	TArray<uint8> Picture;
	if (!Type)
	{
		PlanError = TEXT("A plan is a picture (PNG, JPEG, WebP or GIF) or a PDF.");
	}
	else if (!FFileHelper::LoadFileToArray(Picture, *File))
	{
		PlanError = TEXT("That file could not be opened.");
	}
	else if (Picture.Num() > 4 * 1024 * 1024)
	{
		PlanError = TEXT("That picture is too big: four megabytes at most.");
	}
	else
	{
		PlanError.Reset();
	}
	if (!PlanError.IsEmpty())
	{
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: plan: %s"), *PlanError);
		bShowPlan = true;
		Redraw();
		return;
	}
	bReadingPlan = true;
	bShowPlan = true;
	Redraw();
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: plan: sending a picture of %d bytes (%s) to be read"), Picture.Num(), **Type);
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FEarthWalkConfig::ServerUrl() + TEXT("/v1/plan"));
	Request->SetVerb(TEXT("POST"));
	Request->SetTimeout(180.f); // reading a plan can take a minute
	Request->SetHeader(TEXT("Content-Type"), *Type);
	Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + FEarthWalkConfig::PlayerToken());
	Request->SetContent(MoveTemp(Picture));
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		bReadingPlan = false;
		TSharedPtr<FJsonObject> Got;
		if (Response.IsValid())
		{
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
			FJsonSerializer::Deserialize(Reader, Got);
		}
		const TSharedPtr<FJsonObject>* Plan = nullptr;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200 && Got.IsValid() && Got->TryGetObjectField(TEXT("plan"), Plan))
		{
			PlanRead = Got;
			const TArray<TSharedPtr<FJsonValue>>* Floors = nullptr;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: plan: read, %d floors, %d tries left today"), (*Plan)->TryGetArrayField(TEXT("floors"), Floors) ? Floors->Num() : 0, static_cast<int32>(HomeNum(Got, TEXT("left"))));
		}
		else
		{
			FString Error = Got.IsValid() ? HomeStr(Got, TEXT("error")) : FString();
			if (Error.IsEmpty())
			{
				Error = Response.IsValid() ? TEXT("That did not work. Try again in a moment.") : TEXT("The picture could not be sent. Are you still connected?");
			}
			double TriesLeft = 0.0;
			if (Got.IsValid() && Got->TryGetNumberField(TEXT("left"), TriesLeft))
			{
				const int32 N = static_cast<int32>(TriesLeft);
				Error += FString::Printf(TEXT(" (%s left today)"), N == 0 ? TEXT("no tries") : N == 1 ? TEXT("1 try") : *FString::Printf(TEXT("%d tries"), N));
			}
			PlanError = Error;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: plan: not read (%d): %s"), Response.IsValid() ? Response->GetResponseCode() : 0, *Error);
		}
		if (bOpen)
		{
			bShowPlan = true;
			Redraw();
		}
	});
	Request->ProcessRequest();
}

void UEarthHome::BuildPlan()
{
	UEarthWalkNet* Net = Room();
	const TSharedPtr<FJsonObject>* Plan = nullptr;
	if (!Net || !PlanRead.IsValid() || !PlanRead->TryGetObjectField(TEXT("plan"), Plan))
	{
		return;
	}
	const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetObjectField(TEXT("plan"), *Plan);
	Net->SendHouse(Body);
	PlanRead.Reset();
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: plan: asked for the house to be built from it"));
	bShowPlan = true;
	Redraw();
}

void UEarthHome::DropPlan()
{
	UEarthWalkNet* Net = Room();
	if (!Net || !Net->GetMyHouse().IsValid())
	{
		return;
	}
	const TSharedRef<FJsonObject> Body = MakeShared<FJsonObject>();
	Body->SetField(TEXT("plan"), MakeShared<FJsonValueNull>());
	Net->SendHouse(Body);
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: plan: asked for the house's own rooms back"));
}

void UEarthHome::PlanCommand(const FString& Word)
{
	AEarthWalkHUD* Screen = Hud.Get();
	if (Word == TEXT("build"))
	{
		if (!PlanRead.IsValid() && Screen)
		{
			Screen->AddLine(TEXT("No plan has been read yet: /plan chooses a picture of one."), FLinearColor(0.75f, 0.9f, 1.f));
		}
		BuildPlan();
	}
	else if (Word == TEXT("back"))
	{
		DropPlan();
	}
	else
	{
		ChoosePlan();
	}
}

void UEarthHome::Frame(float DeltaSeconds)
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
	// Home again: on the ground before my own door, not on the porch roof over it.
	if (bArriving && !Me->IsWaitingForGround())
	{
		bArriving = false;
		const TSharedPtr<FJsonObject> Mine = Net->GetMyHouse();
		APlayerController* Mind = Screen->GetOwningPlayerController();
		AEarthWalkCharacter* Walker = Mind ? Cast<AEarthWalkCharacter>(Mind->GetPawn()) : nullptr;
		if (Mine.IsValid() && Walker)
		{
			const double Turn = FMath::DegreesToRadians(HomeNum(Mine, TEXT("yaw")));
			const FVector Door = Earth->GeoToWorld(HomeNum(Mine, TEXT("lat")), HomeNum(Mine, TEXT("lon")), 0.0);
			const double X = Door.Y / 100.0 + FMath::Sin(Turn) * 7.5, Z = -Door.X / 100.0 - FMath::Cos(Turn) * 7.5;
			double Ground = 0.0;
			if (Earth->TerrainHeightAt(X, Z, Ground))
			{
				Walker->PlaceFeetAt(FVector(-Z * 100.0, X * 100.0, (Ground + 0.3) * 100.0));
			}
		}
	}
	const FVector Here = Me->GetActorLocation();
	const double Px = Here.Y / 100.0, Pz = -Here.X / 100.0;

	// The names over the doors of the houses near here that somebody lives in.
	View->Tags.Reset();
	for (const TPair<FString, FEarthLived>& Pair : Net->GetHomes())
	{
		const FVector Door = Earth->GeoToWorld(Pair.Value.Lat, Pair.Value.Lon, 0.0);
		const double X = Door.Y / 100.0, Z = -Door.X / 100.0;
		double Ground = 0.0;
		if (FMath::Abs(X - Px) > HomeTagM || FMath::Abs(Z - Pz) > HomeTagM || (bInside && Pair.Key == InsideKey) || !Earth->TerrainHeightAt(X, Z, Ground))
		{
			continue;
		}
		FVector2D At;
		if (PC->ProjectWorldLocationToScreen(FVector(Door.X, Door.Y, (Ground + 3.4) * 100.0), At, false))
		{
			View->Tags.Emplace(At, HomeDoorName(Pair.Value.Name));
		}
	}

	if ((SinceScan += DeltaSeconds) < 0.3)
	{
		return;
	}
	SinceScan = 0.0;
	if (View->Tags.Num() != TagsLogged)
	{
		TagsLogged = View->Tags.Num();
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: home: %d names over doors on the screen, of %d houses lived in%s"), TagsLogged, Net->GetHomes().Num(),
			TagsLogged > 0 ? *FString::Printf(TEXT("; the first at %.0f, %.0f: %s"), View->Tags[0].Key.X, View->Tags[0].Key.Y, *View->Tags[0].Value) : TEXT(""));
	}
	const UEarthCompany* Company = Earth->GetCompany();
	bInside = Company && Company->InHouse(Inside);
	bInShop = bInside && !Inside.Use.IsEmpty(); // a shop, a café, an office: walked into as a house is, but nobody's to live in
	InsideKey = bInside ? UEarthWalkNet::HouseKey(Inside.Chunk.X, Inside.Chunk.Y, Inside.Id) : FString();
	const FString Mine = MyKey();
	const bool bInMine = bInside && !Mine.IsEmpty() && InsideKey == Mine;
	double FromDoor = TNumericLimits<double>::Max();
	if (const TSharedPtr<FJsonObject> House = Net->GetMyHouse(); House.IsValid() && !Me->IsWaitingForGround())
	{
		const FVector Door = Earth->GeoToWorld(HomeNum(House, TEXT("lat")), HomeNum(House, TEXT("lon")), 0.0);
		FromDoor = FMath::Sqrt(FMath::Square(Door.Y / 100.0 - Px) + FMath::Square(-Door.X / 100.0 - Pz));
	}
	bAtDoor = !bInside && FromDoor < HomeDoorM;
	bAtHome = bInMine || FromDoor < HomeKitchenM;
	Hint = bInMine ? FString(TEXT("H: furnish your house")) : bInside ? (bInShop || Net->GetHomes().Contains(InsideKey) ? FString() : FString(TEXT("H: make this your house")))
		: bAtDoor ? FString(TEXT("H: your house")) : FString();
	if (bOpen && !bInMine && !bAtDoor)
	{
		Close(); // walked away from it
	}
}

void UEarthHome::Redraw()
{
	UEarthWalkNet* Net = Room();
	if (!View.IsValid() || !Net)
	{
		return;
	}
	const TSharedPtr<SScrollBox> Body = View->Body;
	const float Scrolled = Body->GetScrollOffset();
	Body->ClearChildren();
	const TSharedPtr<FJsonObject> House = Net->GetMyHouse();
	const TArray<TSharedPtr<FJsonObject>> Pieces = HomeRows(HomeObj(Journal, TEXT("house")), TEXT("pieces"));
	const auto Heading = [&Body](const FString& Text)
	{
		Body->AddSlot().Padding(2.f, 14.f, 0.f, 6.f)[HomeLine(Text.ToUpper(), TEXT("Bold"), 11, HomeGold)];
	};
	const auto Note = [&Body](const FString& Text)
	{
		Body->AddSlot().Padding(2.f, 2.f, 0.f, 4.f)[HomeLine(Text, TEXT("Regular"), 11, HomeDim, 640.f)];
	};
	if (!House.IsValid() || Pieces.Num() == 0)
	{
		Note(House.IsValid() ? TEXT("Fetching the catalogue...") : TEXT("You have no house yet."));
		return;
	}
	const TWeakObjectPtr<UEarthHome> Self = this;
	const int32 Coins = FMath::RoundToInt32(HomeNum(Journal, TEXT("coins")));
	Note(FString::Printf(TEXT("%d coin%s to spend. A click swaps a piece; the rooms are built again round you."), Coins, Coins == 1 ? TEXT("") : TEXT("s")));
	const TSharedPtr<FJsonObject> Decor = HomeObj(House, TEXT("decor"));
	const auto ColoursOf = [](const TSharedPtr<FJsonObject>& Piece)
	{
		TArray<FColor> Out;
		const TArray<TSharedPtr<FJsonValue>>* Hex = nullptr;
		if (Piece->TryGetArrayField(TEXT("hex"), Hex))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Hex)
			{
				const uint32 Rgb = static_cast<uint32>(Value->AsNumber());
				Out.Add(FColor((Rgb >> 16) & 255, (Rgb >> 8) & 255, Rgb & 255));
			}
		}
		return Out;
	};
	const auto Owned = [](const TSharedPtr<FJsonObject>& Piece)
	{
		bool bOwned = false;
		Piece->TryGetBoolField(TEXT("owned"), bOwned);
		return bOwned;
	};
	/** The price of a piece, or -1 for a prize that can only be won. */
	const auto Price = [](const TSharedPtr<FJsonObject>& Piece)
	{
		double Coins = 0.0;
		return Piece->TryGetNumberField(TEXT("price"), Coins) ? FMath::RoundToInt32(Coins) : -1;
	};

	// The garden: young animals before the front door, fed from the lunch box until they are grown.
	{
		const TArray<TSharedPtr<FJsonObject>> Animals = HomeRows(House, TEXT("animals"));
		const int32 Most = FMath::Max(1, FMath::RoundToInt32(HomeNum(House, TEXT("gardenMax"))));
		const FString Fodder = HomeStr(HomeObj(Journal, TEXT("food")), TEXT("fodder"));
		const auto Flag = [](const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
		{
			bool bOut = false;
			Json->TryGetBoolField(Field, bOut);
			return bOut;
		};
		Heading(FString::Printf(TEXT("Your garden (%d of %d)"), Animals.Num(), Most));
		for (int32 i = 0; i < Animals.Num(); ++i)
		{
			const TSharedPtr<FJsonObject>& Animal = Animals[i];
			const FString Name = HomeStr(Animal, TEXT("name"));
			const FString Gives = HomeStr(Animal, TEXT("gives"));
			const bool bGrown = Flag(Animal, TEXT("grown")), bHungry = Flag(Animal, TEXT("hungry")), bReady = Flag(Animal, TEXT("ready"));
			const FString About = bGrown ? FString::Printf(TEXT("Grown: gives %s a day"), *Gives) : FString::Printf(TEXT("%d of %d meals"), FMath::RoundToInt32(HomeNum(Animal, TEXT("fed"))), FMath::RoundToInt32(HomeNum(Animal, TEXT("meals"))));
			const FString Do = bReady ? FString::Printf(TEXT("Collect %s"), *Gives) : bGrown ? FString(TEXT("Given today")) : !bHungry ? FString(TEXT("Fed today"))
				: !Fodder.IsEmpty() ? FString::Printf(TEXT("Feed it %s"), *Fodder) : FString(TEXT("Nothing it eats in your lunch box"));
			const bool bCan = bGrown ? bReady : bHungry && !Fodder.IsEmpty();
			const bool bSure = Parting == i && FPlatformTime::Seconds() < PartingUntil;
			Body->AddSlot().Padding(0.f, 0.f, 0.f, 4.f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().FillWidth(1.f).VAlign(VAlign_Center)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()[HomeLine(Name.Left(1).ToUpper() + Name.Mid(1), TEXT("Bold"), 12, FLinearColor::White)]
					+ SVerticalBox::Slot().AutoHeight()[HomeLine(About, TEXT("Regular"), 10, HomeDim)]
				]
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6.f, 0.f, 0.f, 0.f)
				[
					View->Small(Do, bCan, [Self, bReady, i]()
					{
						if (UEarthHome* Home = Self.Get())
						{
							Home->Garden(bReady ? TEXT("gather") : TEXT("feed"), FString(), i);
						}
					})
				]
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(6.f, 0.f, 0.f, 0.f)
				[
					View->Small(bSure ? TEXT("Sure? Click again") : TEXT("Send to a farm"), true, [Self, i]()
					{
						if (UEarthHome* Home = Self.Get())
						{
							Home->Garden(TEXT("release"), FString(), i);
						}
					})
				]
			];
		}
		if (Animals.Num() == 0)
		{
			Note(TEXT("A young animal lives before your front door. Feed it once a day from your lunch box (plain vegetables, bread or fruit) and it grows up; then it gives you something every day. It never minds waiting if you are away."));
		}
		const TSharedRef<SWrapBox> Young = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(6.0, 6.0));
		for (const TSharedPtr<FJsonObject>& Breed : HomeRows(House, TEXT("breeds")))
		{
			const FString Sp = HomeStr(Breed, TEXT("sp"));
			const int32 Costs = FMath::RoundToInt32(HomeNum(Breed, TEXT("price")));
			const bool bFull = Animals.Num() >= Most;
			const FColor Coat = Sp == TEXT("chicken") ? FColor(242, 204, 116) : Sp == TEXT("sheep") ? FColor(244, 246, 250) : Sp == TEXT("pig") ? FColor(242, 184, 198) : FColor(111, 74, 48);
			Young->AddSlot()[View->Card({ Coat }, FString::Printf(TEXT("A %s"), *HomeStr(Breed, TEXT("young"))), bFull ? FString(TEXT("The garden is full")) : FString::Printf(TEXT("%d coins"), Costs), false, !bFull && Coins >= Costs, [Self, Sp]()
			{
				if (UEarthHome* Home = Self.Get())
				{
					Home->Garden(TEXT("adopt"), Sp, 0);
				}
			})];
		}
		Body->AddSlot()[Young];
	}

	// Walls, floors, sofa, beds and rugs: what the house came with, or a piece of one's own.
	for (const FHomeSlot& Slot : HomeSlots)
	{
		const FString SlotName = Slot.Slot;
		const FString Chosen = HomeStr(Decor, Slot.Slot);
		Heading(Slot.Title);
		const TSharedRef<SWrapBox> Row = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(6.0, 6.0));
		Row->AddSlot()[View->Card(TArray<FColor>(), Slot.Plain, Chosen.IsEmpty() ? TEXT("In place") : TEXT("Put it back"), Chosen.IsEmpty(), true, [Self, SlotName]()
		{
			if (UEarthHome* Home = Self.Get())
			{
				Home->Put(SlotName, FString());
			}
		})];
		for (const TSharedPtr<FJsonObject>& Piece : Pieces)
		{
			if (HomeStr(Piece, TEXT("slot")) != SlotName)
			{
				continue;
			}
			const FString Id = HomeStr(Piece, TEXT("id"));
			const bool bOn = Chosen == Id, bMine = Owned(Piece);
			const int32 Costs = Price(Piece);
			Row->AddSlot()[View->Card(ColoursOf(Piece), HomeStr(Piece, TEXT("name")), bOn ? FString(TEXT("In place")) : bMine ? FString(TEXT("Yours")) : FString::Printf(TEXT("%d coins"), Costs),
				bOn, bMine || (Costs >= 0 && Coins >= Costs), [Self, SlotName, Id]()
			{
				if (UEarthHome* Home = Self.Get())
				{
					Home->Put(SlotName, Id);
				}
			})];
		}
		Body->AddSlot()[Row];
	}

	// Prizes: won out in the world or bought, and stood in the house for visitors to see.
	TArray<FString> Shown;
	if (Decor.IsValid())
	{
		Decor->TryGetStringArrayField(TEXT("prizes"), Shown);
	}
	const TSharedPtr<FJsonObject> Placed = HomeObj(Decor, TEXT("placed"));
	Heading(FString::Printf(TEXT("Things on show (%d of 10)"), Shown.Num()));
	Note(TEXT("Stand in your house where you want one and press Here: it is put down a step in front of you, facing you, and the furniture makes way. Turn turns it; Wall sends it back to a wall."));
	TArray<TSharedPtr<FJsonObject>> Prizes = Pieces.FilterByPredicate([](const TSharedPtr<FJsonObject>& Piece) { return HomeStr(Piece, TEXT("slot")) == TEXT("prize"); });
	const auto Rank = [&Shown, &Owned, &Price](const TSharedPtr<FJsonObject>& Piece)
	{
		return Shown.Contains(HomeStr(Piece, TEXT("id"))) ? 0 : Owned(Piece) ? 1 : Price(Piece) >= 0 ? 2 : 3;
	};
	Prizes.StableSort([&Rank](const TSharedPtr<FJsonObject>& A, const TSharedPtr<FJsonObject>& B) { return Rank(A) < Rank(B); });
	const TSharedRef<SWrapBox> Shelf = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(6.0, 6.0));
	for (const TSharedPtr<FJsonObject>& Piece : Prizes)
	{
		const FString Id = HomeStr(Piece, TEXT("id"));
		const bool bOn = Shown.Contains(Id), bMine = Owned(Piece);
		const int32 Costs = Price(Piece);
		const FString Words = bOn ? FString(TEXT("On show: put it away")) : bMine ? FString(TEXT("Yours: put it on show")) : Costs >= 0 ? FString::Printf(TEXT("%d coins"), Costs) : HomeStr(Piece, TEXT("how"));
		const TSharedRef<SWidget> One = View->Card(ColoursOf(Piece), HomeStr(Piece, TEXT("name")), Words, bOn, bOn || bMine || (Costs >= 0 && Coins >= Costs), [Self, Id, bOn]()
		{
			if (UEarthHome* Home = Self.Get())
			{
				Home->Show(Id, !bOn);
			}
		});
		if (!bOn)
		{
			Shelf->AddSlot()[One];
			continue;
		}
		// What is on show can be put down wherever I stand, turned, or sent back to a wall.
		const bool bPlaced = Placed.IsValid() && Placed->HasField(Id);
		const auto Act = [this, Self, Id](const TCHAR* Word, int32 How, bool bEnabled)
		{
			return View->Small(Word, bEnabled, [Self, Id, How]()
			{
				if (UEarthHome* Home = Self.Get())
				{
					Home->Place(Id, How);
				}
			});
		};
		Shelf->AddSlot()
		[
			SNew(SVerticalBox)
			+ SVerticalBox::Slot().AutoHeight()[One]
			+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 3.f, 0.f, 0.f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)[Act(TEXT("Here"), 0, bInside)]
				+ SHorizontalBox::Slot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)[Act(TEXT("Turn"), 1, bPlaced)]
				+ SHorizontalBox::Slot().AutoWidth()[Act(TEXT("Wall"), 2, bPlaced)]
			]
		];
	}
	Body->AddSlot()[Shelf];

	// A plan of one's own (planBox in decor.js).
	TArray<FString> Planned;
	House->TryGetStringArrayField(TEXT("planned"), Planned);
	const TSharedRef<SWidget> PlanHeading = HomeLine(TEXT("A PLAN OF YOUR OWN"), TEXT("Bold"), 11, HomeGold);
	Body->AddSlot().Padding(2.f, 14.f, 0.f, 6.f)[PlanHeading];
	const auto PlanButton = [&Body, this](const FString& Word, TFunction<void()> Do)
	{
		Body->AddSlot().HAlign(HAlign_Left).Padding(2.f, 4.f, 0.f, 4.f)[View->Small(Word, true, MoveTemp(Do))];
	};
	if (Planned.Num() > 0)
	{
		Note(TEXT("This house is built from your own plan, at its real size. The front door leads to it; from the street the house looks as it always did."));
		for (const FString& Floor : Planned)
		{
			Note(Floor);
		}
		PlanButton(TEXT("Go back to the house's own rooms"), [Self]()
		{
			if (UEarthHome* Home = Self.Get())
			{
				Home->DropPlan();
			}
		});
	}
	else
	{
		Note(TEXT("Upload a picture of the floor plan of a real house (a photo, a screenshot or a PDF, up to two floors) and the inside of your house is built from it, at its real size, with stairs you can walk up. The outside stays as the map has it."));
	}
	if (!Net->IsSignedIn())
	{
		Note(TEXT("Uploading a plan is for people signed in with their own account."));
	}
	else if (bReadingPlan)
	{
		Body->AddSlot().Padding(2.f, 4.f, 0.f, 4.f)[HomeLine(TEXT("Reading your plan... this can take a minute."), TEXT("Bold"), 11, HomeGold, 640.f)];
	}
	else
	{
		if (!PlanError.IsEmpty())
		{
			Body->AddSlot().Padding(2.f, 2.f, 0.f, 4.f)[HomeLine(PlanError, TEXT("Regular"), 11, FLinearColor(1.f, 0.62f, 0.55f), 640.f)];
		}
		if (PlanRead.IsValid())
		{
			Note(TEXT("This is what was read off your picture:"));
			Body->AddSlot().HAlign(HAlign_Left).Padding(2.f, 2.f, 0.f, 6.f)[SNew(SEarthPlanView, HomeObj(PlanRead, TEXT("plan")))];
			TArray<FString> Lines, Notes;
			PlanRead->TryGetStringArrayField(TEXT("lines"), Lines);
			PlanRead->TryGetStringArrayField(TEXT("notes"), Notes);
			for (const FString& One : Lines)
			{
				Note(One);
			}
			for (const FString& One : Notes)
			{
				Body->AddSlot().Padding(2.f, 2.f, 0.f, 4.f)[HomeLine(One, TEXT("Italic"), 11, HomeGold, 640.f)];
			}
			PlanButton(TEXT("Build my house from this"), [Self]()
			{
				if (UEarthHome* Home = Self.Get())
				{
					Home->BuildPlan();
				}
			});
		}
		PlanButton(PlanRead.IsValid() ? TEXT("Try another picture") : Planned.Num() > 0 ? TEXT("Upload another plan") : TEXT("Choose a picture of a floor plan"), [Self]()
		{
			if (UEarthHome* Home = Self.Get())
			{
				Home->ChoosePlan();
			}
		});
		Note(FString::Printf(TEXT("Three tries a day%s. Your picture is sent to the AI service to be read and is not kept by the game."),
			PlanRead.IsValid() ? *FString::Printf(TEXT(": %d left today"), static_cast<int32>(HomeNum(PlanRead, TEXT("left")))) : TEXT("")));
	}
	Note(TEXT("Your furniture and prizes stay yours if you move. Friends can walk in and look round."));
	Body->AddSlot().HAlign(HAlign_Left).Padding(0.f, 6.f, 0.f, 0.f)
	[
		View->Small(FPlatformTime::Seconds() < LeavingUntil ? TEXT("Really move out? Click again") : TEXT("Move out of this house"), true, [Self]()
		{
			if (UEarthHome* Home = Self.Get())
			{
				Home->MoveOut();
			}
		})
	];
	Body->SetScrollOffset(Scrolled);
	if (bShowPlan)
	{
		bShowPlan = false;
		Body->ScrollDescendantIntoView(PlanHeading, false, EDescendantScrollDestination::TopOrLeft);
	}
}
