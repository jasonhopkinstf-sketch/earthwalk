#include "EarthMiniMap.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Components/SceneCaptureComponent2D.h"
#include "EarthCompany.h"
#include "EarthFlight.h"
#include "EarthGroundCover.h"
#include "EarthLife.h"
#include "EarthSky.h"
#include "EarthWalkHUD.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "Engine/TextureRenderTarget2D.h"
#include "EngineUtils.h"
#include "Fonts/FontMeasure.h"
#include "Framework/Application/SlateApplication.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "Misc/App.h"
#include "Misc/CommandLine.h"
#include "Rendering/DrawElements.h"
#include "Rendering/SlateRenderer.h"
#include "UnrealClient.h"
#include "Styling/CoreStyle.h"
#include "Widgets/SLeafWidget.h"
#include "Widgets/SOverlay.h"

namespace
{
	// The map on the screen: how many pixels a side, and how many metres of the world that is.
	constexpr float SmallSide = 200.f;
	constexpr float LargeSide = 420.f;
	constexpr double SmallSpan = 220.0;
	constexpr double LargeSpan = 640.0;
	constexpr float Edge = 3.f;         // the ink line round it
	constexpr float LegendHeight = 96.f; // under the large map: what each mark is
	// The picture is this much wider than what is shown, so the map can slide under a moving player until the next picture.
	constexpr double PictureSlack = 1.28;
	constexpr int32 SmallRes = 256;
	constexpr int32 LargeRes = 512;
	constexpr double PictureEvery = 0.3; // seconds
	constexpr double CameraUpCm = 100000.0;

	const FLinearColor Ink(FColor(38, 34, 31));
	const FLinearColor PanelColor(FColor(22, 28, 38, 235));
	const FLinearColor Gold(FColor(245, 197, 24));

	float SideOf(int32 Size) { return Size == 2 ? LargeSide : SmallSide; }

	FLinearColor ColourOf(FEarthMapMark::EKind Kind)
	{
		switch (Kind)
		{
		case FEarthMapMark::EKind::Friend: return FLinearColor(FColor(64, 200, 96));
		case FEarthMapMark::EKind::Door: return FLinearColor(FColor(255, 253, 244));
		case FEarthMapMark::EKind::Station: return FLinearColor(FColor(52, 120, 230));
		case FEarthMapMark::EKind::Parked: return FLinearColor(FColor(214, 222, 236));
		case FEarthMapMark::EKind::MyCar: return FLinearColor(FColor(255, 140, 30));
		case FEarthMapMark::EKind::Taxi: return Gold;
		case FEarthMapMark::EKind::Goal: return FLinearColor(FColor(232, 52, 60));
		default: return FLinearColor(FColor(170, 90, 220));
		}
	}

	/** Marks worth pointing to from the edge of the map when they are off it. */
	bool PointsFromEdge(FEarthMapMark::EKind Kind)
	{
		return Kind == FEarthMapMark::EKind::Friend || Kind == FEarthMapMark::EKind::MyCar || Kind == FEarthMapMark::EKind::Taxi
			|| Kind == FEarthMapMark::EKind::Goal || Kind == FEarthMapMark::EKind::Gate;
	}

	FString Far(double Metres)
	{
		return Metres < 950.0 ? FString::Printf(TEXT("%d m"), FMath::RoundToInt32(Metres / 10.0) * 10) : FString::Printf(TEXT("%.1f km"), Metres / 1000.0);
	}
}

/** Draws the map: the picture, the marks over it, and under the large one what each mark is. */
class SEarthMiniMapView : public SLeafWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthMiniMapView) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, TSharedPtr<FEarthMapView> InView)
	{
		View = InView;
		SetVisibility(EVisibility::HitTestInvisible);
	}

	virtual FVector2D ComputeDesiredSize(float) const override
	{
		if (!View.IsValid() || View->Size == 0)
		{
			return FVector2D::ZeroVector;
		}
		const float Whole = SideOf(View->Size) + 2.f * Edge;
		return FVector2D(Whole, Whole + (View->Size == 2 ? LegendHeight + 6.f : 0.f));
	}

	virtual int32 OnPaint(const FPaintArgs& Args, const FGeometry& Geo, const FSlateRect& Culling, FSlateWindowElementList& Out, int32 Layer, const FWidgetStyle& Style, bool bParentEnabled) const override
	{
		if (!View.IsValid() || View->Size == 0)
		{
			return Layer;
		}
		const FEarthMapView& V = *View;
		const float Side = SideOf(V.Size);
		const float Whole = Side + 2.f * Edge;
		const FVector2f Middle(Edge + Side * 0.5f, Edge + Side * 0.5f);
		const float PerMetre = Side / float(V.Span);
		const TSharedRef<FSlateFontMeasure> Measure = FSlateApplication::Get().GetRenderer()->GetFontMeasureService();
		const FSlateFontInfo Small = FCoreStyle::GetDefaultFontStyle("Bold", 8);
		const FSlateFontInfo Plain = FCoreStyle::GetDefaultFontStyle("Bold", 9);
		const FSlateFontInfo Words = FCoreStyle::GetDefaultFontStyle("Regular", 10);

		const auto Box = [&](int32 L, FVector2f At, FVector2f Size, const FSlateBrush* Brush, const FLinearColor& Tint, ESlateDrawEffect Effect = ESlateDrawEffect::None)
		{
			FSlateDrawElement::MakeBox(Out, L, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(At)), Brush, Effect, Tint);
		};
		// Align: -1 starts at At, 0 is centred on it, 1 ends at it. A dark copy a pixel off makes it read over anything.
		const auto Text = [&](int32 L, FVector2f At, const FString& String, const FSlateFontInfo& Font, const FLinearColor& Colour, int32 Align, bool bShadow = true)
		{
			const FVector2f Size(Measure->Measure(String, Font));
			At.X -= Align == 0 ? Size.X * 0.5f : Align > 0 ? Size.X : 0.f;
			if (bShadow)
			{
				FSlateDrawElement::MakeText(Out, L, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(At + FVector2f(1.f, 1.f))), String, Font, ESlateDrawEffect::None, FLinearColor(0.f, 0.f, 0.f, 0.9f));
			}
			FSlateDrawElement::MakeText(Out, L + 1, Geo.ToPaintGeometry(Size, FSlateLayoutTransform(At)), String, Font, ESlateDrawEffect::None, Colour);
		};
		const auto Line = [&](int32 L, const TArray<FVector2f>& Points, const FLinearColor& Colour, float Thick)
		{
			FSlateDrawElement::MakeLines(Out, L, Geo.ToPaintGeometry(), Points, ESlateDrawEffect::None, Colour, true, Thick);
		};
		// One mark, centred on a spot: a disc or a square in its colour with an ink line round it.
		const auto Symbol = [&](int32 L, FEarthMapMark::EKind Kind, FVector2f At)
		{
			const FLinearColor Colour = ColourOf(Kind);
			// Doors and parked cars are many, and small; the rest are few, and stand out.
			const float Wide = Kind == FEarthMapMark::EKind::Parked ? 7.f : Kind == FEarthMapMark::EKind::Door ? 6.f : Kind == FEarthMapMark::EKind::Goal ? 17.f : 14.f;
			const FSlateBrush* Shape = Kind == FEarthMapMark::EKind::Door ? &SmallSquare : Kind == FEarthMapMark::EKind::Station ? &Square : Kind == FEarthMapMark::EKind::Parked ? &SmallDisc : &Disc;
			Box(L, At - FVector2f(Wide * 0.5f), FVector2f(Wide), Shape, Colour);
			if (Kind == FEarthMapMark::EKind::Goal)
			{
				Box(L + 1, At - FVector2f(3.f), FVector2f(6.f), &Dot, FLinearColor::White);
			}
			else if (Kind == FEarthMapMark::EKind::MyCar || Kind == FEarthMapMark::EKind::Taxi)
			{
				Text(L + 1, At - FVector2f(0.f, 6.5f), Kind == FEarthMapMark::EKind::Taxi ? TEXT("T") : TEXT("C"), Small, Ink, 0, false);
			}
		};

		// The frame, and the world from above inside it.
		Box(Layer, FVector2f::ZeroVector, FVector2f(Whole), &Frame, FLinearColor::White);
		if (V.bPicture)
		{
			const double Shown = V.Span / V.PictureSpan;
			const double U = 0.5 + (V.MeX - V.CentreX) / V.PictureSpan - Shown * 0.5;
			const double W = 0.5 + (V.MeZ - V.CentreZ) / V.PictureSpan - Shown * 0.5;
			Picture = V.Picture;
			Picture.SetUVRegion(FBox2f(FVector2f(float(U), float(W)), FVector2f(float(U + Shown), float(W + Shown))));
			Box(Layer + 1, FVector2f(Edge), FVector2f(Side), &Picture, FLinearColor::White, ESlateDrawEffect::IgnoreTextureAlpha);
		}

		Out.PushClip(FSlateClippingZone(Geo.MakeChild(FVector2f(Side), FSlateLayoutTransform(FVector2f(Edge)))));
		const auto Spot = [&](double X, double Z) { return Middle + FVector2f(float(X - V.MeX), float(Z - V.MeZ)) * PerMetre; };
		const float Reach = Side * 0.5f;

		// The road to where the player is being taken.
		if (V.Way.Num() > 1)
		{
			TArray<FVector2f> Points;
			Points.Reserve(V.Way.Num());
			for (const FVector2D& Point : V.Way)
			{
				Points.Add(Spot(Point.X, Point.Y));
			}
			Line(Layer + 2, Points, Ink, 6.f);
			Line(Layer + 3, Points, Gold, 3.f);
		}

		// What is on the map; and at its edge, pointing the way, what matters and is off it.
		const FEarthMapMark* Goal = nullptr;
		for (const FEarthMapMark& Mark : V.Marks)
		{
			if (Mark.Kind == FEarthMapMark::EKind::Goal)
			{
				Goal = &Mark;
			}
			const FVector2f Away = FVector2f(float(Mark.X - V.MeX), float(Mark.Z - V.MeZ)) * PerMetre;
			const float Most = FMath::Max(FMath::Abs(Away.X), FMath::Abs(Away.Y));
			if (Most <= Reach - 6.f)
			{
				const int32 L = Layer + (PointsFromEdge(Mark.Kind) ? 8 : Mark.Kind == FEarthMapMark::EKind::Station ? 6 : 4);
				Symbol(L, Mark.Kind, Middle + Away);
				if (!Mark.Label.IsEmpty() && (V.Size == 2 || Mark.Kind == FEarthMapMark::EKind::Friend))
				{
					Text(L + 2, Middle + Away + FVector2f(10.f, -7.f), Mark.Label.Left(18), Small, FLinearColor::White, -1);
				}
				continue;
			}
			if (!PointsFromEdge(Mark.Kind) && !Mark.bPoint)
			{
				continue;
			}
			FVector2f At = Middle + Away * ((Reach - 11.f) / Most);
			// Clear of the line along the foot of the map that names the place, and of the M in its corner.
			const float FootLine = Edge + Side - (V.Going.IsEmpty() ? 0.f : 22.f);
			At.Y = FMath::Min(At.Y, FootLine - 11.f);
			if (At.Y > FootLine - 36.f && At.X < Edge + 36.f)
			{
				At.X = Edge + 36.f;
			}
			const FVector2f Along = Away.GetSafeNormal();
			const FVector2f Across(-Along.Y, Along.X);
			const TArray<FVector2f> Arrow = { At - Along * 5.f + Across * 6.f, At + Along * 5.f, At - Along * 5.f - Across * 6.f };
			Line(Layer + 8, Arrow, Ink, 7.f);
			Line(Layer + 9, Arrow, ColourOf(Mark.Kind), 4.f);
			if (Mark.Kind == FEarthMapMark::EKind::Friend && !Mark.Label.IsEmpty())
			{
				// The name, inside the arrow: read away from whichever side of the map the arrow is on.
				const int32 Align = Along.X < -0.4f ? -1 : Along.X > 0.4f ? 1 : 0;
				const float NameX = Align < 0 ? At.X + 11.f : Align > 0 ? At.X - 11.f : FMath::Clamp(At.X, Edge + 40.f, Edge + Side - 40.f);
				const float NameY = Align != 0 ? At.Y - 6.f : Along.Y < 0.f ? At.Y + 9.f : At.Y - 22.f;
				Text(Layer + 10, FVector2f(NameX, FMath::Clamp(NameY, Edge + 3.f, Edge + Side - 17.f)), Mark.Label.Left(12), Small, FLinearColor::White, Align);
			}
		}

		// The player: which way they look, and an arrowhead on the spot.
		{
			const float Turn = FMath::DegreesToRadians(float(V.MeYaw));
			const FVector2f Ahead(FMath::Sin(Turn), -FMath::Cos(Turn));
			const FVector2f Side2(Ahead.Y * -1.f, Ahead.X);
			const TArray<FVector2f> Head = { Middle + Ahead * 10.f, Middle - Ahead * 7.f + Side2 * 7.f, Middle - Ahead * 2.5f, Middle - Ahead * 7.f - Side2 * 7.f, Middle + Ahead * 10.f };
			Line(Layer + 12, Head, Ink, 7.f);
			Line(Layer + 13, Head, FLinearColor::White, 3.5f);
			Box(Layer + 14, Middle - FVector2f(3.f) + Ahead * 1.f, FVector2f(6.f), &Dot, FLinearColor::White);
		}

		// North, the key that changes the map, and where the player is being taken.
		Text(Layer + 15, FVector2f(Middle.X, Edge + 3.f), TEXT("N"), Plain, FLinearColor::White, 0);
		float Foot = Edge + Side;
		if (!V.Going.IsEmpty())
		{
			Foot -= 22.f;
			Box(Layer + 15, FVector2f(Edge, Foot), FVector2f(Side, 22.f), &Flat, FLinearColor(0.05f, 0.07f, 0.1f, 0.82f));
			// "Cheltenham Beach, Narrow Neck" is "Cheltenham Beach" on the small map: there is room for little more.
			FString Name = V.Going;
			int32 Comma = INDEX_NONE;
			if (V.Size != 2 && Name.FindChar(TEXT(','), Comma))
			{
				Name.LeftInline(Comma);
			}
			const int32 Room = V.Size == 2 ? 44 : 17;
			if (Name.Len() > Room)
			{
				Name = Name.Left(Room - 1).TrimEnd() + TEXT("\u2026");
			}
			FString Where = FString::Printf(TEXT("To %s"), *Name);
			if (Goal)
			{
				Where += FString::Printf(TEXT("  ·  %s"), V.GoingFar >= 0.0 ? *EarthFlightSums::FarWords(V.GoingFar) : *Far(FMath::Sqrt(FMath::Square(Goal->X - V.MeX) + FMath::Square(Goal->Z - V.MeZ))));
			}
			Text(Layer + 16, FVector2f(Middle.X, Foot + 4.f), Where, Plain, Gold, 0);
		}
		Box(Layer + 15, FVector2f(Edge + 5.f, Foot - 23.f), FVector2f(18.f), &Key, Gold);
		Text(Layer + 16, FVector2f(Edge + 14.f, Foot - 21.f), TEXT("M"), Plain, Ink, 0, false);
		Out.PopClip();

		// Under the large map: what each mark is.
		if (V.Size == 2)
		{
			const float Top = Whole + 6.f;
			Box(Layer, FVector2f(0.f, Top), FVector2f(Whole, LegendHeight), &Panel, PanelColor);
			static const TPair<FEarthMapMark::EKind, const TCHAR*> Rows[] = {
				{ FEarthMapMark::EKind::Friend, TEXT("A friend") },
				{ FEarthMapMark::EKind::Door, TEXT("A door you can go in") },
				{ FEarthMapMark::EKind::Station, TEXT("A train stops here") },
				{ FEarthMapMark::EKind::Parked, TEXT("A parked car") },
				{ FEarthMapMark::EKind::MyCar, TEXT("Your own car") },
				{ FEarthMapMark::EKind::Taxi, TEXT("Your taxi") },
				{ FEarthMapMark::EKind::Goal, TEXT("Where you are going") },
				{ FEarthMapMark::EKind::Gate, TEXT("A gate of the race") },
			};
			for (int32 i = 0; i < UE_ARRAY_COUNT(Rows); ++i)
			{
				const FVector2f At(18.f + (i / 4) * (Whole * 0.5f), Top + 15.f + (i % 4) * 21.f);
				Symbol(Layer + 1, Rows[i].Key, At);
				Text(Layer + 3, At + FVector2f(14.f, -7.5f), Rows[i].Value, Words, FLinearColor::White, -1, false);
			}
		}
		return Layer + 17;
	}

private:
	TSharedPtr<FEarthMapView> View;
	mutable FSlateBrush Picture;
	FSlateRoundedBoxBrush Frame = FSlateRoundedBoxBrush(FLinearColor(FColor(16, 22, 30)), 5.f, Ink, Edge);
	FSlateRoundedBoxBrush Panel = FSlateRoundedBoxBrush(FLinearColor::White, 8.f);
	FSlateRoundedBoxBrush Flat = FSlateRoundedBoxBrush(FLinearColor::White, 0.f);
	FSlateRoundedBoxBrush Key = FSlateRoundedBoxBrush(FLinearColor::White, 4.f, Ink, 1.5f);
	FSlateRoundedBoxBrush Disc = FSlateRoundedBoxBrush(FLinearColor::White, 9.f, Ink, 2.f);
	FSlateRoundedBoxBrush SmallDisc = FSlateRoundedBoxBrush(FLinearColor::White, 4.f, Ink, 1.f);
	FSlateRoundedBoxBrush SmallSquare = FSlateRoundedBoxBrush(FLinearColor::White, 1.f, Ink, 1.f);
	FSlateRoundedBoxBrush Square = FSlateRoundedBoxBrush(FLinearColor::White, 2.5f, Ink, 2.f);
	FSlateRoundedBoxBrush Dot = FSlateRoundedBoxBrush(FLinearColor::White, 3.f);
};

void UEarthMiniMap::Setup(AEarthWalkHUD* InHud)
{
	if (!InHud || !GEngine || !GEngine->GameViewport)
	{
		return;
	}
	Hud = InHud;
	View = MakeShared<FEarthMapView>();
	bCost = FParse::Param(FCommandLine::Get(), TEXT("EWMapCost"));

	Target = NewObject<UTextureRenderTarget2D>(this);
	Target->RenderTargetFormat = RTF_RGBA8_SRGB;
	Target->ClearColor = FLinearColor(0.012f, 0.016f, 0.024f, 1.f);
	Target->bAutoGenerateMips = false;
	Target->InitAutoFormat(SmallRes, SmallRes);
	Target->UpdateResourceImmediate(true);

	// The camera: straight down from a kilometre up, with no perspective, taking the bare colours of things.
	Camera = NewObject<USceneCaptureComponent2D>(InHud);
	Camera->ProjectionType = ECameraProjectionMode::Orthographic;
	Camera->CaptureSource = ESceneCaptureSource::SCS_BaseColor;
	Camera->TextureTarget = Target;
	Camera->bCaptureEveryFrame = false;
	Camera->bCaptureOnMovement = false;
	Camera->ShowFlags.SetFog(false);
	Camera->ShowFlags.SetVolumetricFog(false);
	Camera->ShowFlags.SetAtmosphere(false);
	Camera->ShowFlags.SetDynamicShadows(false);
	Camera->ShowFlags.SetAmbientOcclusion(false);
	Camera->ShowFlags.SetGlobalIllumination(false);
	Camera->ShowFlags.SetLumenGlobalIllumination(false);
	Camera->ShowFlags.SetLumenReflections(false);
	Camera->ShowFlags.SetReflectionEnvironment(false);
	Camera->ShowFlags.SetScreenSpaceReflections(false);
	Camera->ShowFlags.SetSkyLighting(false);
	Camera->ShowFlags.SetBloom(false);
	Camera->ShowFlags.SetMotionBlur(false);
	Camera->ShowFlags.SetEyeAdaptation(false);
	Camera->ShowFlags.SetAntiAliasing(false);
	Camera->ShowFlags.SetPostProcessing(false);
	Camera->ShowFlags.SetTranslucency(false);
	Camera->ShowFlags.SetParticles(false);
	Camera->ShowFlags.SetDecals(false);
	Camera->ShowFlags.SetLighting(false); // the bare colours need no lights worked out: this alone halves what a picture costs
	Camera->RegisterComponent();

	View->Picture.SetResourceObject(Target);
	View->Picture.DrawAs = ESlateBrushDrawType::Image;
	View->Picture.Tiling = ESlateBrushTileType::NoTile;

	SAssignNew(Widget, SOverlay).Visibility(EVisibility::HitTestInvisible)
		+ SOverlay::Slot().HAlign(HAlign_Right).VAlign(VAlign_Top).Padding(12.f)
		[
			SNew(SEarthMiniMapView, View)
		];
	// Under everything else on the screen (the passport, the menu), which may cover it.
	GEngine->GameViewport->AddViewportWidgetContent(Widget.ToSharedRef(), 9);

	FString Saved;
	const bool bSaved = FEarthWalkConfig::HasOverride(TEXT("Map"), Saved);
	SetSize(bSaved && Saved.Equals(TEXT("off"), ESearchCase::IgnoreCase) ? 0 : bSaved && Saved.Equals(TEXT("big"), ESearchCase::IgnoreCase) ? 2 : 1);
}

void UEarthMiniMap::Shutdown()
{
	if (Widget.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(Widget.ToSharedRef());
	}
	Widget.Reset();
	if (Camera)
	{
		Camera->DestroyComponent();
		Camera = nullptr;
	}
	Target = nullptr;
	View.Reset();
}

void UEarthMiniMap::SetSize(int32 NewSize)
{
	if (!View.IsValid() || !Target || !Camera)
	{
		return;
	}
	View->Size = FMath::Clamp(NewSize, 0, 2);
	if (View->Size != 0)
	{
		const int32 Res = View->Size == 2 ? LargeRes : SmallRes;
		if (Target->SizeX != Res)
		{
			Target->ResizeTarget(Res, Res);
		}
		View->Span = View->Size == 2 ? LargeSpan : SmallSpan;
		View->PictureSpan = View->Span * PictureSlack;
		View->Picture.ImageSize = FVector2D(Res, Res);
		View->bPicture = false;
		Camera->OrthoWidth = float(View->PictureSpan * 100.0);
		StillAt = 0.0;
	}
	if (Widget.IsValid())
	{
		Widget->Invalidate(EInvalidateWidgetReason::Layout);
	}
}

FString UEarthMiniMap::Cycle()
{
	if (!View.IsValid())
	{
		return FString();
	}
	const int32 Next = View->Size == 1 ? 2 : View->Size == 2 ? 0 : 1;
	SetSize(Next);
	FEarthWalkConfig::Save(TEXT("Map"), Next == 0 ? TEXT("off") : Next == 2 ? TEXT("big") : TEXT("small"));
	return Next == 2 ? TEXT("The map is bigger, and says what each mark is. M again hides it.")
		: Next == 0 ? TEXT("The map is hidden. M brings it back.")
		: TEXT("The little map is back. M makes it bigger.");
}

void UEarthMiniMap::TakePicture(const FVector& Here)
{
	// On a whole dot of the picture, so that the picture does not shimmer as the player moves.
	const double Dot = View->PictureSpan * 100.0 / double(Target->SizeX);
	const double X = FMath::RoundToDouble(Here.X / Dot) * Dot;
	const double Y = FMath::RoundToDouble(Here.Y / Dot) * Dot;
	// Pitched straight down with no turn, north is the top of the picture and east its right.
	Camera->SetWorldLocationAndRotation(FVector(X, Y, Here.Z + CameraUpCm), FRotator(-90.0, 0.0, 0.0));
	Camera->CaptureSceneDeferred();
	View->CentreX = Y / 100.0;
	View->CentreZ = -X / 100.0;
	View->bPicture = true;
	PictureAt = FPlatformTime::Seconds();
}

void UEarthMiniMap::FindStill()
{
	Still.Reset();
	const AEarthWalkHUD* Screen = Hud.Get();
	const AEarthWorld* Earth = Screen ? AEarthWorld::Get(Screen) : nullptr;
	if (!Earth)
	{
		return;
	}
	const double Reach = View->Span * 0.75; // to the corners
	TArray<FEarthDoor> Doors;
	Earth->DoorsNear(View->MeX, View->MeZ, Reach, Doors);
	for (const FEarthDoor& Door : Doors)
	{
		FEarthMapMark& Mark = Still.AddDefaulted_GetRef();
		Mark.Kind = FEarthMapMark::EKind::Door;
		Mark.X = Door.X;
		Mark.Z = Door.Z;
	}
	if (const AEarthLife* Life = Earth->GetLife())
	{
		TArray<FEarthSpot> Spots;
		Life->ParkedNear(View->MeX, View->MeZ, Reach, Spots);
		for (const FEarthSpot& Spot : Spots)
		{
			FEarthMapMark& Mark = Still.AddDefaulted_GetRef();
			Mark.Kind = FEarthMapMark::EKind::Parked;
			Mark.X = Spot.X;
			Mark.Z = Spot.Z;
		}
		Spots.Reset();
		// Stations from farther off than the map shows: the nearest is pointed to from the edge, to walk to.
		Life->StopsNear(View->MeX, View->MeZ, 1500.0, Spots);
		int32 Nearest = INDEX_NONE;
		double Best = TNumericLimits<double>::Max();
		for (const FEarthSpot& Spot : Spots)
		{
			const double Off = FMath::Square(Spot.X - View->MeX) + FMath::Square(Spot.Z - View->MeZ);
			if (Off < Best)
			{
				Best = Off;
				Nearest = Still.Num();
			}
			FEarthMapMark& Mark = Still.AddDefaulted_GetRef();
			Mark.Kind = FEarthMapMark::EKind::Station;
			Mark.X = Spot.X;
			Mark.Z = Spot.Z;
		}
		if (Nearest != INDEX_NONE)
		{
			Still[Nearest].bPoint = true;
		}
	}

	// -EWMapLog: what was found, in the log now and then, for tests.
	static const bool bLog = FParse::Param(FCommandLine::Get(), TEXT("EWMapLog"));
	static int32 Logged = 0;
	if (bLog && (Logged++ % 8 == 0 || !View->Going.IsEmpty()))
	{
		int32 Counts[3] = { 0, 0, 0 };
		FString Stops;
		for (const FEarthMapMark& Mark : Still)
		{
			++Counts[Mark.Kind == FEarthMapMark::EKind::Door ? 0 : Mark.Kind == FEarthMapMark::EKind::Parked ? 1 : 2];
			if (Mark.Kind == FEarthMapMark::EKind::Station)
			{
				Stops += FString::Printf(TEXT(" (%.0f m east, %.0f m south)"), Mark.X - View->MeX, Mark.Z - View->MeZ);
			}
		}
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: map: %d doors and %d parked cars within %.0f m, %d train stops within 1500 m:%s; going to \"%s\" by a way of %d points"),
			Counts[0], Counts[1], Reach, Counts[2], *Stops, *View->Going, View->Way.Num());
	}

	// What the camera above leaves out: the player (the arrowhead stands for them), the sky, and the tufts of grass.
	Camera->HiddenActors.Reset();
	if (const APlayerController* PC = Screen->GetOwningPlayerController())
	{
		if (APawn* Pawn = PC->GetPawn())
		{
			Camera->HiddenActors.Add(Pawn);
		}
	}
	for (TActorIterator<AEarthSky> It(Screen->GetWorld()); It; ++It)
	{
		Camera->HiddenActors.Add(*It);
	}
	for (TActorIterator<AEarthGroundCover> It(Screen->GetWorld()); It; ++It)
	{
		Camera->HiddenActors.Add(*It);
	}
}

void UEarthMiniMap::Frame(float DeltaSeconds)
{
	if (!View.IsValid() || !Camera || !Target)
	{
		return;
	}
	if (bCost)
	{
		CostTest(DeltaSeconds);
	}
	const AEarthWalkHUD* Screen = Hud.Get();
	const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
	const APawn* Pawn = PC ? PC->GetPawn() : nullptr;
	const AEarthWorld* Earth = Screen ? AEarthWorld::Get(Screen) : nullptr;
	if (View->Size == 0 || !Pawn || !Earth)
	{
		return;
	}
	const FVector Here = Pawn->GetActorLocation();
	View->MeX = Here.Y / 100.0;
	View->MeZ = -Here.X / 100.0;
	View->MeYaw = PC->PlayerCameraManager ? PC->PlayerCameraManager->GetCameraRotation().Yaw : PC->GetControlRotation().Yaw;

	const UEarthWalkNet* Net = Screen->GetGameInstance() ? Screen->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	const double Now = FPlatformTime::Seconds();
	if (Now - StillAt > 1.0)
	{
		StillAt = Now;
		FindStill();
	}

	// A new picture three times a second, or at once when the player has outrun the last one (sent somewhere else, say).
	const double Room = (View->PictureSpan - View->Span) * 0.5;
	const bool bOutrun = FMath::Max(FMath::Abs(View->MeX - View->CentreX), FMath::Abs(View->MeZ - View->CentreZ)) > Room;
	if (!View->bPicture || bOutrun || Now - PictureAt > PictureEvery)
	{
		TakePicture(Here);
	}

	View->Marks = Still;
	if (Net)
	{
		for (const TPair<FString, FEarthPeer>& Pair : Net->GetPeers())
		{
			if (!Pair.Value.bHasPosition)
			{
				continue;
			}
			const FVector At = Earth->GeoToWorld(Pair.Value.Lat, Pair.Value.Lon, 0.0);
			FEarthMapMark& Mark = View->Marks.AddDefaulted_GetRef();
			Mark.Kind = FEarthMapMark::EKind::Friend;
			Mark.X = At.Y / 100.0;
			Mark.Z = -At.X / 100.0;
			Mark.Label = Pair.Value.Name;
		}
	}
	View->Way.Reset();
	View->Going.Reset();
	if (const UEarthCompany* Company = Earth->GetCompany())
	{
		Company->MapMarks(View->Marks, View->Way, View->Going);
	}
	// Being flown somewhere: the place, on the map or pointed to from its edge, and how far is left.
	View->GoingFar = -1.0;
	double FlightX = 0.0, FlightZ = 0.0, FlightLeft = 0.0;
	FString FlightName;
	if (const UEarthFlight* Flight = Hud.IsValid() ? Hud->GetFlight() : nullptr; Flight && Flight->MapGoal(FlightX, FlightZ, FlightName, FlightLeft))
	{
		View->Marks.RemoveAll([](const FEarthMapMark& Mark) { return Mark.Kind == FEarthMapMark::EKind::Goal; });
		FEarthMapMark& Mark = View->Marks.AddDefaulted_GetRef();
		Mark.Kind = FEarthMapMark::EKind::Goal;
		Mark.X = FlightX;
		Mark.Z = FlightZ;
		Mark.Label = FlightName;
		View->Way.Reset();
		View->Going = FlightName;
		View->GoingFar = FlightLeft;
	}

	// -EWMapTripShot=<file>: a picture of the screen four seconds into being taken somewhere (or -EWMapTripShotAt=<seconds>), for tests: a trip starts when it starts.
	static const FString TripShot = []() { FString File; FParse::Value(FCommandLine::Get(), TEXT("-EWMapTripShot="), File); return File; }();
	static double TripFor = 0.0;
	if (!TripShot.IsEmpty() && TripFor >= 0.0 && !View->Going.IsEmpty())
	{
		TripFor += DeltaSeconds;
		static const float TripShotAt = []() { float At = 4.f; FParse::Value(FCommandLine::Get(), TEXT("-EWMapTripShotAt="), At); return At; }();
		if (TripFor > TripShotAt)
		{
			TripFor = -1.0;
			FScreenshotRequest::RequestScreenshot(TripShot, true, false);
		}
	}
}

/**
 * -EWMapCost: half a minute in, with the frame rate let run as fast as it will, the map is hidden,
 * small and large by turns for six seconds each, three times round, and the time a frame took in each
 * is written to the log.
 */
void UEarthMiniMap::CostTest(float DeltaSeconds)
{
	const double Now = FPlatformTime::Seconds();
	if (CostStart == 0.0)
	{
		CostStart = Now + 30.0;
		return;
	}
	if (Now < CostStart)
	{
		return;
	}
	constexpr double Each = 6.0;
	constexpr int32 Rounds = 3;
	const int32 Phase = FMath::FloorToInt32((Now - CostStart) / Each);
	if (Phase != CostPhase)
	{
		if (CostPhase < 0)
		{
			SizeBeforeCost = View->Size;
			GEngine->bSmoothFrameRate = false;
			if (const AEarthWalkHUD* Screen = Hud.Get())
			{
				GEngine->Exec(Screen->GetWorld(), TEXT("r.VSync 0"));
				GEngine->Exec(Screen->GetWorld(), TEXT("t.MaxFPS 0"));
			}
		}
		if (Phase >= 3 * Rounds)
		{
			const auto Mean = [this](int32 i) { return CostFrames[i] ? CostSum[i] / CostFrames[i] * 1000.0 : 0.0; };
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: map cost: a frame took %.2f ms with the map hidden, %.2f ms with it small, %.2f ms with it large (%d, %d and %d frames)"),
				Mean(0), Mean(1), Mean(2), CostFrames[0], CostFrames[1], CostFrames[2]);
			bCost = false;
			SetSize(SizeBeforeCost);
			return;
		}
		CostPhase = Phase;
		SetSize(Phase % 3);
	}
	if (Now - (CostStart + Phase * Each) > 1.0)
	{
		CostSum[Phase % 3] += FApp::GetDeltaTime();
		++CostFrames[Phase % 3];
	}
}
