#include "EarthWorldMap.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Dom/JsonObject.h"
#include "EarthFlight.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Engine/Texture2D.h"
#include "Fonts/FontMeasure.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "IImageWrapper.h"
#include "IImageWrapperModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Modules/ModuleManager.h"
#include "Rendering/DrawElements.h"
#include "Rendering/SlateRenderer.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Styling/CoreStyle.h"
#include "TextureResource.h"
#include "Widgets/Input/SButton.h"
#include "Widgets/Layout/SBorder.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/SBoxPanel.h"
#include "Widgets/SCompoundWidget.h"
#include "Widgets/SLeafWidget.h"
#include "Widgets/SOverlay.h"
#include "Widgets/Text/STextBlock.h"

#include <cmath>

namespace
{
	const FLinearColor MapInk(FColor(38, 34, 31));
	const FLinearColor MapPanel(FColor(22, 28, 38, 242));
	const FLinearColor MapGold(FColor(245, 197, 24));
	const FLinearColor MapNotice(0.75f, 0.9f, 1.f);
	constexpr int32 KeptPictures = 220; // held at once
	constexpr int32 AtOnce = 6;         // asked for at once

	FString MapKey(int32 Z, int32 X, int32 Y) { return FString::Printf(TEXT("%d/%d/%d"), Z, X, Y); }

	/** Where the pointer is on the map, from the middle of it, in pixels. */
	FVector2D FromMiddle(const FGeometry& Geo, const FPointerEvent& Event)
	{
		return FVector2D(Geo.AbsoluteToLocal(Event.GetScreenSpacePosition())) - FVector2D(Geo.GetLocalSize()) * 0.5;
	}

	TSharedRef<STextBlock> MapLine(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Colour, float Wrap = 0.f)
	{
		return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Colour).WrapTextAt(Wrap).Text(FText::FromString(Text));
	}
}

// ---------------------------------------------------------------- the sums (mapview.js)

FVector2D EarthMapSums::PointOf(double Lat, double Lon, double Zoom)
{
	const double Size = TilePx * std::pow(2.0, Zoom);
	const double R = FMath::DegreesToRadians(FMath::Clamp(Lat, -85.0511, 85.0511));
	return FVector2D(((Lon + 180.0) / 360.0) * Size, ((1.0 - std::asinh(std::tan(R)) / UE_DOUBLE_PI) / 2.0) * Size);
}

FVector2D EarthMapSums::GeoOf(double X, double Y, double Zoom)
{
	const double Size = TilePx * std::pow(2.0, Zoom);
	// East and west it goes round: 190 east is 170 west.
	const double Lon = std::fmod(std::fmod((X / Size) * 360.0, 360.0) + 360.0, 360.0) - 180.0;
	const double Lat = FMath::RadiansToDegrees(std::atan(std::sinh(UE_DOUBLE_PI * (1.0 - (2.0 * FMath::Clamp(Y, 0.0, Size)) / Size))));
	return FVector2D(Lat, Lon);
}

void EarthMapSums::TilesFor(const FVector2D& Mid, double Zoom, double W, double H, TArray<FTile>& Out)
{
	Out.Reset();
	const int32 Z = FMath::Clamp(FMath::RoundToInt32(Zoom), 0, MaxTileZoom);
	const double Size = TilePx * std::pow(2.0, Zoom - Z);
	const int32 N = 1 << Z;
	const int32 X0 = FMath::FloorToInt32((Mid.X - W / 2.0) / Size), X1 = FMath::FloorToInt32((Mid.X + W / 2.0) / Size);
	const int32 Y0 = FMath::Max(0, FMath::FloorToInt32((Mid.Y - H / 2.0) / Size)), Y1 = FMath::Min(N - 1, FMath::FloorToInt32((Mid.Y + H / 2.0) / Size));
	for (int32 Ty = Y0; Ty <= Y1; ++Ty)
	{
		for (int32 Tx = X0; Tx <= X1; ++Tx)
		{
			FTile& Tile = Out.AddDefaulted_GetRef();
			Tile.Z = Z;
			Tile.X = ((Tx % N) + N) % N;
			Tile.Y = Ty;
			Tile.Left = Tx * Size;
			Tile.Top = Ty * Size;
			Tile.Size = Size;
		}
	}
}

FString EarthMapSums::AwayWords(double FromLat, double FromLon, double ToLat, double ToLon)
{
	const double Metres = EarthFlightSums::MetresBetween(FromLat, FromLon, ToLat, ToLon);
	if (Metres < 30.0)
	{
		return TEXT("Right where you are");
	}
	double DLon = ToLon - FromLon;
	if (DLon > 180.0)
	{
		DLon -= 360.0;
	}
	else if (DLon < -180.0)
	{
		DLon += 360.0;
	}
	static const TCHAR* const Winds[] = { TEXT("north"), TEXT("north-east"), TEXT("east"), TEXT("south-east"), TEXT("south"), TEXT("south-west"), TEXT("west"), TEXT("north-west") };
	const double Bearing = FMath::RadiansToDegrees(std::atan2(DLon * std::cos(FMath::DegreesToRadians(FromLat)), ToLat - FromLat));
	const int32 Wind = FMath::RoundToInt32(std::fmod(std::fmod(Bearing, 360.0) + 360.0, 360.0) / 45.0) % 8;
	return FString::Printf(TEXT("%s to the %s of you"), *EarthFlightSums::FarWords(Metres), Winds[Wind]);
}

// ---------------------------------------------------------------- the map itself: drawn, dragged, clicked

/** The pictures of the map with the marks over them. It takes the mouse: a drag moves the map, the wheel zooms, a click chooses. */
class SEarthMapCanvas : public SLeafWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthMapCanvas) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, UEarthWorldMap* InOwner)
	{
		Owner = InOwner;
		SetCursor(EMouseCursor::GrabHand);
	}

	virtual FVector2D ComputeDesiredSize(float) const override { return FVector2D(640.0, 400.0); }

	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geo, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		UEarthWorldMap* Map = Owner.Get();
		const FSlateBrush* White = FCoreStyle::Get().GetBrush("WhiteBrush");
		const FVector2D Size(Geo.GetLocalSize());
		FSlateDrawElement::MakeBox(Out, Layer, Geo.ToPaintGeometry(), White, ESlateDrawEffect::None, FLinearColor(FColor(0xcf, 0xd8, 0xdc)));
		if (!Map)
		{
			return Layer;
		}
		// Nothing is drawn outside the map's own frame: the pictures at its edges run past it.
		Out.PushClip(FSlateClippingZone(Geo));
		const double Zoom = Map->GetZoom();
		const FVector2D Centre = Map->GetCentre();
		const FVector2D Mid = EarthMapSums::PointOf(Centre.X, Centre.Y, Zoom);
		TArray<EarthMapSums::FTile> Tiles;
		EarthMapSums::TilesFor(Mid, Zoom, Size.X, Size.Y, Tiles);
		for (const EarthMapSums::FTile& Tile : Tiles)
		{
			if (const FSlateBrush* Picture = Map->PictureOf(Tile.Z, Tile.X, Tile.Y))
			{
				const FVector2f At(Tile.Left - Mid.X + Size.X / 2.0, Tile.Top - Mid.Y + Size.Y / 2.0);
				FSlateDrawElement::MakeBox(Out, Layer + 1, Geo.ToPaintGeometry(FVector2f(Tile.Size + 0.5, Tile.Size + 0.5), FSlateLayoutTransform(At)), Picture, ESlateDrawEffect::None, FLinearColor::White);
			}
		}
		const auto ScreenOf = [&](double Lat, double Lon)
		{
			const FVector2D P = EarthMapSums::PointOf(Lat, Lon, Zoom);
			return FVector2D(P.X - Mid.X + Size.X / 2.0, P.Y - Mid.Y + Size.Y / 2.0);
		};
		const auto Square = [&](int32 At, const FVector2D& Middle, double Half, const FLinearColor& Colour)
		{
			FSlateDrawElement::MakeBox(Out, At, Geo.ToPaintGeometry(FVector2f(Half * 2.0 + 5.0, Half * 2.0 + 5.0), FSlateLayoutTransform(FVector2f(Middle.X - Half - 2.5, Middle.Y - Half - 2.5))), White, ESlateDrawEffect::None, MapInk);
			FSlateDrawElement::MakeBox(Out, At + 1, Geo.ToPaintGeometry(FVector2f(Half * 2.0, Half * 2.0), FSlateLayoutTransform(FVector2f(Middle.X - Half, Middle.Y - Half))), White, ESlateDrawEffect::None, Colour);
		};
		const TSharedRef<FSlateFontMeasure> Measure = FSlateApplication::Get().GetRenderer()->GetFontMeasureService();
		const FSlateFontInfo Font = FCoreStyle::GetDefaultFontStyle("Bold", 9);
		const auto Label = [&](int32 At, const FString& Text, const FVector2D& Middle)
		{
			const FVector2f Took(Measure->Measure(Text, Font));
			const FVector2f Corner(Middle.X - Took.X * 0.5f, Middle.Y - Took.Y * 0.5f);
			FSlateDrawElement::MakeBox(Out, At, Geo.ToPaintGeometry(Took + FVector2f(8.f, 2.f), FSlateLayoutTransform(Corner - FVector2f(4.f, 1.f))), White, ESlateDrawEffect::None, FLinearColor(1.f, 1.f, 1.f, 0.9f));
			FSlateDrawElement::MakeText(Out, At + 1, Geo.ToPaintGeometry(Took, FSlateLayoutTransform(Corner)), Text, Font, ESlateDrawEffect::None, MapInk);
		};

		// Friends, then me, then the place chosen.
		TArray<UEarthWorldMap::FMark> Friends;
		Map->Friends(Friends);
		for (const UEarthWorldMap::FMark& Friend : Friends)
		{
			const FVector2D At = ScreenOf(Friend.Lat, Friend.Lon);
			if (At.X < -40.0 || At.Y < -40.0 || At.X > Size.X + 40.0 || At.Y > Size.Y + 40.0)
			{
				continue;
			}
			Square(Layer + 2, At, 6.0, FLinearColor(FColor(0x3f, 0xb9, 0x50)));
			Label(Layer + 4, Friend.Name, At - FVector2D(0.0, 18.0));
		}
		UEarthWorldMap::FMark Me;
		if (Map->Me(Me))
		{
			// An arrowhead, pointing the way the player faces: its outline in ink, and in gold over that.
			const FVector2D At = ScreenOf(Me.Lat, Me.Lon);
			const double A = FMath::DegreesToRadians(Me.Heading);
			const FVector2D Up(std::sin(A), -std::cos(A)), Right(std::cos(A), std::sin(A));
			const auto Corner = [&](double Ahead, double Aside) { return FVector2f(At + Up * Ahead + Right * Aside); };
			const TArray<FVector2f> Arrow = { Corner(14.0, 0.0), Corner(-10.0, 9.0), Corner(-5.0, 0.0), Corner(-10.0, -9.0), Corner(14.0, 0.0) };
			FSlateDrawElement::MakeLines(Out, Layer + 6, Geo.ToPaintGeometry(), Arrow, ESlateDrawEffect::None, MapInk, true, 8.f);
			FSlateDrawElement::MakeLines(Out, Layer + 7, Geo.ToPaintGeometry(), Arrow, ESlateDrawEffect::None, MapGold, true, 4.f);
			Label(Layer + 8, TEXT("You"), At - FVector2D(0.0, 24.0));
		}
		if (Map->HasPick())
		{
			// A pin: a red head on a stalk, its foot on the place.
			const FVector2D Pick = Map->GetPick();
			const FVector2D At = ScreenOf(Pick.X, Pick.Y);
			FSlateDrawElement::MakeLines(Out, Layer + 10, Geo.ToPaintGeometry(), TArray<FVector2f>{ FVector2f(At), FVector2f(At - FVector2D(0.0, 22.0)) }, ESlateDrawEffect::None, MapInk, true, 4.f);
			Square(Layer + 11, At - FVector2D(0.0, 28.0), 8.0, FLinearColor(FColor(0xd8, 0x3a, 0x2e)));
		}
		Out.PopClip();
		return Layer + 12;
	}

	virtual FReply OnMouseButtonDown(const FGeometry& Geo, const FPointerEvent& Event) override
	{
		if (Event.GetEffectingButton() != EKeys::LeftMouseButton || !Owner.IsValid())
		{
			return FReply::Unhandled();
		}
		bDown = true;
		Moved = 0.0;
		DownAt = FVector2D(Geo.AbsoluteToLocal(Event.GetScreenSpacePosition()));
		From = EarthMapSums::PointOf(Owner->GetCentre().X, Owner->GetCentre().Y, Owner->GetZoom());
		return FReply::Handled().CaptureMouse(SharedThis(this));
	}

	virtual FReply OnMouseMove(const FGeometry& Geo, const FPointerEvent& Event) override
	{
		if (!bDown || !Owner.IsValid())
		{
			return FReply::Unhandled();
		}
		const FVector2D Now(Geo.AbsoluteToLocal(Event.GetScreenSpacePosition()));
		Moved = FMath::Max(Moved, FVector2D::Distance(Now, DownAt));
		if (Moved >= 4.0)
		{
			Owner->DragBy(From, Now - DownAt);
		}
		return FReply::Handled();
	}

	virtual FReply OnMouseButtonUp(const FGeometry& Geo, const FPointerEvent& Event) override
	{
		if (!bDown || Event.GetEffectingButton() != EKeys::LeftMouseButton)
		{
			return FReply::Unhandled();
		}
		bDown = false;
		if (Moved < 4.0 && Owner.IsValid())
		{
			Owner->Choose(FromMiddle(Geo, Event));
		}
		return FReply::Handled().ReleaseMouseCapture();
	}

	virtual FReply OnMouseWheel(const FGeometry& Geo, const FPointerEvent& Event) override
	{
		if (Owner.IsValid())
		{
			Owner->ZoomBy(Event.GetWheelDelta() > 0.f ? 0.5 : -0.5, FromMiddle(Geo, Event));
		}
		return FReply::Handled();
	}

	/** How big the map is on the screen, for the owner's sums. */
	FVector2D LocalSize() const { return FVector2D(GetTickSpaceGeometry().GetLocalSize()); }
	/** Where on the desktop a point of the map is, given from the middle of it: for the test that works the mouse. */
	FVector2D DesktopOf(const FVector2D& FromMid) const
	{
		const FGeometry& Space = GetTickSpaceGeometry();
		return FVector2D(Space.LocalToAbsolute(FVector2D(Space.GetLocalSize()) * 0.5 + FromMid));
	}

private:
	TWeakObjectPtr<UEarthWorldMap> Owner;
	bool bDown = false;
	double Moved = 0.0;
	FVector2D DownAt = FVector2D::ZeroVector;
	FVector2D From = FVector2D::ZeroVector;
};

/** The map in its frame, with its words, its buttons, the credit OpenStreetMap asks for, and the card for the place chosen. */
class SEarthWorldMapView : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthWorldMapView) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, UEarthWorldMap* InOwner)
	{
		Owner = InOwner;
		SetVisibility(EVisibility::Collapsed);
		const TWeakObjectPtr<UEarthWorldMap> Self = InOwner;
		const auto Button = [this, Self](const FString& Word, const FString& Tip, TFunction<void(UEarthWorldMap&)> Do)
		{
			return SNew(SBox).WidthOverride(74.f).HeightOverride(30.f)
			[
				SNew(SButton)
				.ButtonStyle(&KeyButton)
				.IsFocusable(false)
				.ToolTipText(FText::FromString(Tip))
				.HAlign(HAlign_Center)
				.VAlign(VAlign_Center)
				.OnClicked_Lambda([Self, Do]()
				{
					if (UEarthWorldMap* Map = Self.Get())
					{
						Do(*Map);
					}
					return FReply::Handled();
				})
				[
					MapLine(Word, TEXT("Bold"), 10, MapInk)
				]
			];
		};
		const auto Way = [this, Self](int32 How, const FString& Head, const FString& About, bool bMain)
		{
			return SNew(SButton)
				.ButtonStyle(bMain ? &MainButton : &WayButton)
				.IsFocusable(false)
				.ContentPadding(FMargin(10.f, 7.f))
				.OnClicked_Lambda([Self, How]()
				{
					if (UEarthWorldMap* Map = Self.Get())
					{
						Map->Go(How);
					}
					return FReply::Handled();
				})
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight()[MapLine(Head, TEXT("Bold"), 12, bMain ? MapInk : FLinearColor::White)]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 2.f, 0.f, 0.f)[MapLine(About, TEXT("Regular"), 9, bMain ? MapInk : FLinearColor(1.f, 1.f, 1.f, 0.85f), 176.f)]
				];
		};
		ChildSlot
		.Padding(FMargin(24.f, 60.f, 24.f, 64.f))
		[
			SNew(SBorder)
			.BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
			.BorderBackgroundColor(MapInk)
			.Padding(3.f)
			[
				SNew(SOverlay)
				+ SOverlay::Slot()
				[
					SAssignNew(Canvas, SEarthMapCanvas, InOwner)
				]
				+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(10.f)
				[
					SNew(SBorder)
					.BorderImage(&Rounded)
					.BorderBackgroundColor(MapPanel)
					.Padding(FMargin(12.f, 7.f))
					.Visibility(EVisibility::HitTestInvisible)
					[
						SNew(SHorizontalBox)
						+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 10.f, 0.f)[MapLine(TEXT("The world map"), TEXT("Bold"), 13, FLinearColor::White)]
						+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[MapLine(TEXT("Drag to look round  ·  wheel to zoom  ·  click where you want to go  ·  N or Esc to close"), TEXT("Regular"), 10, FLinearColor(1.f, 1.f, 1.f, 0.8f))]
					]
				]
				+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Top).Padding(10.f)
				[
					SNew(SVerticalBox)
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 6.f)[Button(TEXT("Closer"), TEXT("Closer"), [](UEarthWorldMap& Map) { Map.ZoomBy(1.0, FVector2D::ZeroVector); })]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 6.f)[Button(TEXT("Further"), TEXT("Further off"), [](UEarthWorldMap& Map) { Map.ZoomBy(-1.0, FVector2D::ZeroVector); })]
					+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 0.f, 0.f, 6.f)[Button(TEXT("Me"), TEXT("Back to where I am"), [](UEarthWorldMap& Map) { Map.Home(); })]
					+ SVerticalBox::Slot().AutoHeight()[Button(TEXT("Colours"), TEXT("Brighter colours, or the map as it comes"), [](UEarthWorldMap& Map) { Map.SwitchLook(); })]
				]
				+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Bottom).Padding(6.f)
				[
					SNew(SBorder)
					.BorderImage(FCoreStyle::Get().GetBrush("WhiteBrush"))
					.BorderBackgroundColor(FLinearColor(1.f, 1.f, 1.f, 0.88f))
					.Padding(FMargin(7.f, 2.f))
					.Visibility(EVisibility::HitTestInvisible)
					[
						MapLine(TEXT("© OpenStreetMap contributors  ·  openstreetmap.org/copyright"), TEXT("Regular"), 9, MapInk)
					]
				]
				+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Bottom).Padding(0.f, 0.f, 0.f, 34.f)
				[
					SAssignNew(Card, SBorder)
					.BorderImage(&Rounded)
					.BorderBackgroundColor(MapPanel)
					.Padding(FMargin(16.f, 12.f, 16.f, 10.f))
					.Visibility(EVisibility::Collapsed)
					[
						SNew(SBox).WidthOverride(620.f)
						[
							SNew(SVerticalBox)
							+ SVerticalBox::Slot().AutoHeight()[SAssignNew(Title, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Bold", 15)).ColorAndOpacity(FLinearColor::White)]
							+ SVerticalBox::Slot().AutoHeight().Padding(0.f, 1.f, 0.f, 9.f)[SAssignNew(Sub, STextBlock).Font(FCoreStyle::GetDefaultFontStyle("Regular", 10)).ColorAndOpacity(FLinearColor(1.f, 1.f, 1.f, 0.8f))]
							+ SVerticalBox::Slot().AutoHeight()
							[
								SNew(SHorizontalBox)
								+ SHorizontalBox::Slot().FillWidth(1.f).Padding(0.f, 0.f, 8.f, 0.f)[Way(0, TEXT("Call a taxi"), TEXT("It comes to you. Hop on (E) and it drives you there."), true)]
								+ SHorizontalBox::Slot().FillWidth(1.f).Padding(0.f, 0.f, 8.f, 0.f)[Way(1, TEXT("Fly there"), TEXT("You are carried there, and watch the world go by."), false)]
								+ SHorizontalBox::Slot().FillWidth(1.f)[Way(2, TEXT("Go there now"), TEXT("You land there at once."), false)]
							]
							+ SVerticalBox::Slot().AutoHeight().HAlign(HAlign_Left).Padding(0.f, 8.f, 0.f, 0.f)
							[
								SNew(SButton)
								.ButtonStyle(&WayButton)
								.IsFocusable(false)
								.ContentPadding(FMargin(8.f, 3.f))
								.OnClicked_Lambda([Self]()
								{
									if (UEarthWorldMap* Map = Self.Get())
									{
										Map->ClearPick();
									}
									return FReply::Handled();
								})
								[
									MapLine(TEXT("Somewhere else"), TEXT("Regular"), 9, FLinearColor::White)
								]
							]
						]
					]
				]
			]
		];
	}

	void SetCard(bool bShown, const FString& InTitle, const FString& InSub)
	{
		Card->SetVisibility(bShown ? EVisibility::Visible : EVisibility::Collapsed);
		Title->SetText(FText::FromString(InTitle));
		Sub->SetText(FText::FromString(InSub));
	}

	FVector2D MapSize() const { return Canvas.IsValid() ? Canvas->LocalSize() : FVector2D(1280.0, 720.0); }
	FVector2D DesktopOf(const FVector2D& FromMid) const { return Canvas.IsValid() ? Canvas->DesktopOf(FromMid) : FromMid; }

private:
	TWeakObjectPtr<UEarthWorldMap> Owner;
	TSharedPtr<SEarthMapCanvas> Canvas;
	TSharedPtr<SBorder> Card;
	TSharedPtr<STextBlock> Title;
	TSharedPtr<STextBlock> Sub;
	FSlateRoundedBoxBrush Rounded = FSlateRoundedBoxBrush(FLinearColor::White, 10.f);
	// The buttons at the side: white, with an ink line round them, as in the browser.
	FButtonStyle KeyButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor::White, 8.f, MapInk, 2.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 240, 180)), 8.f, MapInk, 2.f))
		.SetPressed(FSlateRoundedBoxBrush(MapGold, 8.f, MapInk, 2.f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor::White, 8.f, MapInk, 2.f));
	// The card's: the taxi in gold, the other ways plain.
	FButtonStyle MainButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(MapGold, 9.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 221, 87)), 9.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(214, 168, 10)), 9.f))
		.SetDisabled(FSlateRoundedBoxBrush(MapGold, 9.f));
	FButtonStyle WayButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 26)), 9.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 9.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 9.f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 12)), 9.f));
};

// ---------------------------------------------------------------- the world map

void UEarthWorldMap::Setup(AEarthWalkHUD* InHud)
{
	if (!InHud || !GEngine || !GEngine->GameViewport)
	{
		return;
	}
	Hud = InHud;
	FString Kept;
	bBright = !(FEarthWalkConfig::HasOverride(TEXT("MapLook"), Kept) && Kept.Equals(TEXT("plain"), ESearchCase::IgnoreCase));
	SAssignNew(View, SEarthWorldMapView, this);
	GEngine->GameViewport->AddViewportWidgetContent(View.ToSharedRef(), 12);
}

void UEarthWorldMap::Shutdown()
{
	Close();
	if (View.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(View.ToSharedRef());
	}
	View.Reset();
	Brushes.Reset();
	Pictures.Reset();
	Queue.Reset();
}

void UEarthWorldMap::Toggle()
{
	if (bOpen)
	{
		Close();
		return;
	}
	FMark Here;
	if (!View.IsValid() || !Me(Here))
	{
		return;
	}
	bOpen = true;
	View->SetVisibility(EVisibility::Visible);
	Home();
	if (const AEarthWalkHUD* Screen = Hud.Get())
	{
		if (const APlayerController* PC = Screen->GetOwningPlayerController())
		{
			if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
			{
				Character->bTyping = true; // the keys are the map's while it is up
			}
		}
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: world map: opened at %.4f, %.4f"), CentreLat, CentreLon);
}

void UEarthWorldMap::Close()
{
	if (!bOpen)
	{
		return;
	}
	bOpen = false;
	if (View.IsValid())
	{
		View->SetVisibility(EVisibility::Collapsed);
	}
	if (const AEarthWalkHUD* Screen = Hud.Get())
	{
		if (const APlayerController* PC = Screen->GetOwningPlayerController())
		{
			if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
			{
				Character->bTyping = false;
			}
		}
	}
}

bool UEarthWorldMap::Me(FMark& Out) const
{
	const AEarthWalkHUD* Screen = Hud.Get();
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	const AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const AEarthWorld* Earth = Screen ? AEarthWorld::Get(Screen) : nullptr;
	if (!Character || !Earth || Character->IsWaitingForGround())
	{
		return false;
	}
	double Alt = 0.0;
	Earth->WorldToGeo(Character->GetActorLocation(), Out.Lat, Out.Lon, Alt);
	Out.Heading = Character->GetActorRotation().Yaw; // north is the engine's X, so the turn about Z is the compass heading
	Out.Name = TEXT("You");
	return true;
}

void UEarthWorldMap::Friends(TArray<FMark>& Out) const
{
	Out.Reset();
	const AEarthWalkHUD* Screen = Hud.Get();
	const UGameInstance* Instance = Screen ? Screen->GetGameInstance() : nullptr;
	const UEarthWalkNet* Net = Instance ? Instance->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net)
	{
		return;
	}
	for (const TPair<FString, FEarthPeer>& Pair : Net->GetPeers())
	{
		if (Pair.Value.bHasPosition)
		{
			FMark& Mark = Out.AddDefaulted_GetRef();
			Mark.Lat = Pair.Value.Lat;
			Mark.Lon = Pair.Value.Lon;
			Mark.Name = Pair.Value.Name;
		}
	}
}

void UEarthWorldMap::Home()
{
	FMark Here;
	if (Me(Here))
	{
		CentreLat = Here.Lat;
		CentreLon = Here.Lon;
	}
	Zoom = EarthMapSums::StartZoom;
	ClearPick();
}

void UEarthWorldMap::DragBy(const FVector2D& From, const FVector2D& Pixels)
{
	const FVector2D Geo = EarthMapSums::GeoOf(From.X - Pixels.X, From.Y - Pixels.Y, Zoom);
	CentreLat = Geo.X;
	CentreLon = Geo.Y;
}

void UEarthWorldMap::ZoomBy(double By, const FVector2D& About)
{
	// The place under the pointer stays under it (zoomAbout of mapview.js).
	const double Next = FMath::Clamp(Zoom + By, EarthMapSums::MinZoom, EarthMapSums::MaxZoom);
	const FVector2D Mid = EarthMapSums::PointOf(CentreLat, CentreLon, Zoom);
	const FVector2D Under = EarthMapSums::GeoOf(Mid.X + About.X, Mid.Y + About.Y, Zoom);
	const FVector2D There = EarthMapSums::PointOf(Under.X, Under.Y, Next);
	const FVector2D Geo = EarthMapSums::GeoOf(There.X - About.X, There.Y - About.Y, Next);
	Zoom = Next;
	CentreLat = Geo.X;
	CentreLon = Geo.Y;
}

void UEarthWorldMap::SwitchLook()
{
	bBright = !bBright;
	FEarthWalkConfig::Save(TEXT("MapLook"), bBright ? TEXT("bright") : TEXT("plain"));
	// The pictures are coloured as they come in, so they are asked for again.
	++LookSerial;
	Pictures.Reset();
	Brushes.Reset();
	Used.Reset();
	Asked.Reset();
	None.Reset();
	Queue.Reset();
}

void UEarthWorldMap::TestMouse(const FString& What)
{
	// For tests, which have no hands: a turn of the wheel, a drag and a click, each sent through the engine's own
	// handling of the mouse, so that what is tried is what a real mouse does. The real pointer is not moved.
	if (!bOpen || !View.IsValid() || !FSlateApplication::IsInitialized())
	{
		return;
	}
	FSlateApplication& Slate = FSlateApplication::Get();
	const TSet<FKey> Held = { EKeys::LeftMouseButton };
	const auto Pointer = [&](const FVector2D& At, const FVector2D& Was, bool bHeld, const FKey& Button, float Wheel)
	{
		return FPointerEvent(FSlateApplication::CursorPointerIndex, View->DesktopOf(At), View->DesktopOf(Was), bHeld ? Held : TSet<FKey>(), Button, Wheel, FModifierKeysState());
	};
	if (What == TEXT("wheel"))
	{
		Slate.ProcessMouseWheelOrGestureEvent(Pointer(FVector2D::ZeroVector, FVector2D::ZeroVector, false, EKeys::Invalid, 1.f), nullptr);
	}
	else if (What == TEXT("drag"))
	{
		// 200 to the left and 100 up, in ten moves.
		const FVector2D From(60.0, 42.0);
		Slate.ProcessMouseButtonDownEvent(nullptr, Pointer(From, From, true, EKeys::LeftMouseButton, 0.f));
		for (int32 i = 1; i <= 10; ++i)
		{
			Slate.ProcessMouseMoveEvent(Pointer(From - FVector2D(20.0, 10.0) * i, From - FVector2D(20.0, 10.0) * (i - 1), true, EKeys::Invalid, 0.f));
		}
		Slate.ProcessMouseButtonUpEvent(Pointer(From - FVector2D(200.0, 100.0), From - FVector2D(200.0, 100.0), false, EKeys::LeftMouseButton, 0.f));
	}
	else if (What == TEXT("click"))
	{
		const FVector2D At(160.0, -108.0);
		Slate.ProcessMouseButtonDownEvent(nullptr, Pointer(At, At, true, EKeys::LeftMouseButton, 0.f));
		Slate.ProcessMouseButtonUpEvent(Pointer(At, At, false, EKeys::LeftMouseButton, 0.f));
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: world map: after the mouse's %s: zoom %.2f, middle %.5f, %.5f"), *What, Zoom, CentreLat, CentreLon);
}

// ---------------------------------------------------------------- the pictures

const FSlateBrush* UEarthWorldMap::PictureOf(int32 Z, int32 X, int32 Y)
{
	const FString Key = MapKey(Z, X, Y);
	const double Now = FPlatformTime::Seconds();
	if (const TSharedPtr<FSlateBrush>* Brush = Brushes.Find(Key))
	{
		Used.Add(Key, Now);
		return Brush->Get();
	}
	if (!Asked.Contains(Key) && None.FindRef(Key) < Now)
	{
		Asked.Add(Key);
		Queue.Add({ Z, X, Y, Key });
		Pump();
	}
	return nullptr;
}

void UEarthWorldMap::Pump()
{
	while (Asking < AtOnce && Queue.Num() > 0)
	{
		const FWant Want = Queue.Pop(); // what was asked for last is what is being looked at now
		Ask(Want.Z, Want.X, Want.Y, Want.Key);
	}
}

void UEarthWorldMap::Ask(int32 Z, int32 X, int32 Y, const FString& Key)
{
	++Asking;
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("%s/v1/maptile/%d/%d/%d.png"), *FEarthWalkConfig::ServerUrl(), Z, X, Y));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(25.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	const int32 Serial = LookSerial;
	const bool bBrighter = bBright;
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Key, Serial, bBrighter](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		--Asking;
		if (Serial != LookSerial)
		{
			Pump();
			return; // the colours were changed meanwhile: this one is asked for again
		}
		Asked.Remove(Key);
		UTexture2D* Texture = nullptr;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200)
		{
			const TArray<uint8>& Data = Response->GetContent();
			IImageWrapperModule& Module = FModuleManager::LoadModuleChecked<IImageWrapperModule>(TEXT("ImageWrapper"));
			const TSharedPtr<IImageWrapper> Png = Module.CreateImageWrapper(EImageFormat::PNG);
			TArray64<uint8> Raw;
			if (Png.IsValid() && Png->SetCompressed(Data.GetData(), Data.Num()) && Png->GetRaw(ERGBFormat::BGRA, 8, Raw))
			{
				const int32 W = Png->GetWidth(), H = Png->GetHeight();
				if (W > 0 && H > 0 && W <= 1024 && H <= 1024 && Raw.Num() == int64(W) * H * 4)
				{
					if (bBrighter)
					{
						// Brighter, to sit beside the game's own colours: every colour further from its own grey, and a touch
						// more contrast and light (the browser's "saturate(1.9) contrast(1.06) brightness(1.03)").
						for (int64 i = 0; i < Raw.Num(); i += 4)
						{
							const float B = Raw[i], G = Raw[i + 1], R = Raw[i + 2];
							const float Grey = 0.2126f * R + 0.7152f * G + 0.0722f * B;
							const auto Brighter = [Grey](float C) { return static_cast<uint8>(FMath::Clamp(((Grey + (C - Grey) * 1.9f - 127.5f) * 1.06f + 127.5f) * 1.03f, 0.f, 255.f)); };
							Raw[i] = Brighter(B);
							Raw[i + 1] = Brighter(G);
							Raw[i + 2] = Brighter(R);
						}
					}
					Texture = UTexture2D::CreateTransient(W, H, PF_B8G8R8A8);
					if (Texture && Texture->GetPlatformData() && Texture->GetPlatformData()->Mips.Num() > 0)
					{
						Texture->SRGB = true;
						Texture->Filter = TF_Bilinear;
						Texture->AddressX = TA_Clamp;
						Texture->AddressY = TA_Clamp;
						FTexture2DMipMap& Mip = Texture->GetPlatformData()->Mips[0];
						void* Pixels = Mip.BulkData.Lock(LOCK_READ_WRITE);
						FMemory::Memcpy(Pixels, Raw.GetData(), Raw.Num());
						Mip.BulkData.Unlock();
						Texture->UpdateResource();
					}
				}
			}
		}
		const double Now = FPlatformTime::Seconds();
		if (Texture)
		{
			Pictures.Add(Key, Texture);
			const TSharedPtr<FSlateBrush> Brush = MakeShared<FSlateBrush>();
			Brush->SetResourceObject(Texture);
			Brush->ImageSize = FVector2D(Texture->GetSizeX(), Texture->GetSizeY());
			Brush->DrawAs = ESlateBrushDrawType::Image;
			Brushes.Add(Key, Brush);
			Used.Add(Key, Now);
			// No more than so many are held: those looked at longest ago go.
			while (Brushes.Num() > KeptPictures)
			{
				FString Oldest;
				double At = TNumericLimits<double>::Max();
				for (const TPair<FString, double>& Pair : Used)
				{
					if (Pair.Value < At)
					{
						At = Pair.Value;
						Oldest = Pair.Key;
					}
				}
				Brushes.Remove(Oldest);
				Pictures.Remove(Oldest);
				Used.Remove(Oldest);
			}
		}
		else
		{
			None.Add(Key, Now + 8.0); // asked for again a little later, if it is still being looked at
			static double LoggedAt = 0.0;
			if (Now - LoggedAt > 10.0)
			{
				LoggedAt = Now;
				UE_LOG(LogTemp, Display, TEXT("EarthWalk: world map: no picture of %s (%d)"), *Key, Response.IsValid() ? Response->GetResponseCode() : 0);
			}
		}
		Pump();
	});
	Request->ProcessRequest();
}

// ---------------------------------------------------------------- choosing a place

void UEarthWorldMap::Choose(const FVector2D& FromMiddle)
{
	const FVector2D Mid = EarthMapSums::PointOf(CentreLat, CentreLon, Zoom);
	const FVector2D Geo = EarthMapSums::GeoOf(Mid.X + FromMiddle.X, Mid.Y + FromMiddle.Y, Zoom);
	bPick = true;
	PickLat = Geo.X;
	PickLon = Geo.Y;
	PickName.Reset();
	bPickNamed = false;
	FMark Here;
	PickAway = Me(Here) ? EarthMapSums::AwayWords(Here.Lat, Here.Lon, PickLat, PickLon) : FString();
	ShowCard();
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: world map: chose %.5f, %.5f (%s)"), PickLat, PickLon, *PickAway);
	// It is named by its neighbourhood: the server tells the place search no more than that (GET /v1/place).
	const int32 Serial = ++PickSerial;
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("%s/v1/place?lat=%.2f&lon=%.2f"), *FEarthWalkConfig::ServerUrl(), PickLat, PickLon));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(20.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Serial](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		if (Serial != PickSerial || !bPick)
		{
			return; // somewhere else was clicked meanwhile
		}
		TSharedPtr<FJsonObject> Json;
		FString Name, Country;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200
			&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Json) && Json.IsValid())
		{
			Json->TryGetStringField(TEXT("name"), Name);
			Json->TryGetStringField(TEXT("country"), Country);
		}
		PickName = !Name.IsEmpty() && !Country.IsEmpty() && !Name.Contains(Country) ? Name + TEXT(", ") + Country : Name;
		bPickNamed = true;
		ShowCard();
	});
	Request->ProcessRequest();
}

void UEarthWorldMap::ClearPick()
{
	bPick = false;
	++PickSerial;
	ShowCard();
}

void UEarthWorldMap::ShowCard()
{
	if (View.IsValid())
	{
		View->SetCard(bPick, !bPickNamed ? FString(TEXT("Looking that up...")) : PickName.IsEmpty() ? FString(TEXT("The place you picked")) : PickName,
			PickAway.IsEmpty() ? FString(TEXT("How would you like to get there?")) : PickAway + TEXT(". How would you like to get there?"));
	}
}

void UEarthWorldMap::Go(int32 How)
{
	if (!bPick)
	{
		return;
	}
	const FString Name = PickName.IsEmpty() ? FString(TEXT("the place you picked")) : TEXT("a spot in ") + PickName;
	const double Lat = PickLat, Lon = PickLon;
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: world map: %s to %s"), How == 0 ? TEXT("a taxi") : How == 1 ? TEXT("a flight") : TEXT("at once"), *Name);
	Close();
	if (AEarthWalkHUD* Screen = Hud.Get())
	{
		Screen->MapGo(How, Name, Lat, Lon);
	}
}
