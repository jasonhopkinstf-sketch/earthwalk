#include "EarthHome.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Dom/JsonObject.h"
#include "EarthCompany.h"
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
	const double Out = 4.5, Turn = FMath::DegreesToRadians(Yaw); // the way out of the door; far enough back to see the name over it
	Screen->AddLine(TEXT("Going home..."), FLinearColor(0.75f, 0.9f, 1.f));
	Close();
	Me->TeleportToGeo(Lat + (FMath::Cos(Turn) * Out) / 111320.0, Lon + (FMath::Sin(Turn) * Out) / (111320.0 * FMath::Cos(FMath::DegreesToRadians(Lat))));
	PC->SetControlRotation(FRotator(8.0, Yaw + 180.0, 0.0)); // facing the door, and up a little at the name over it
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
			const double X = Door.Y / 100.0 + FMath::Sin(Turn) * 4.5, Z = -Door.X / 100.0 - FMath::Cos(Turn) * 4.5;
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
	Hint = bInMine ? FString(TEXT("H: furnish your house")) : bInside ? (Net->GetHomes().Contains(InsideKey) ? FString() : FString(TEXT("H: make this your house")))
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

	// A plan of one's own, and the garden: the browser game's so far.
	TArray<FString> Planned;
	House->TryGetStringArrayField(TEXT("planned"), Planned);
	Heading(TEXT("A plan of your own, and your garden"));
	if (Planned.Num() > 0)
	{
		Note(TEXT("This house is built from your own floor plan. The browser game shows it at its real size; this game shows its ordinary rooms for now."));
		for (const FString& Floor : Planned)
		{
			Note(Floor);
		}
	}
	else
	{
		Note(TEXT("In the browser game you can upload a picture of a real floor plan and have the inside of your house built from it. Not in this game yet."));
	}
	Note(TEXT("The garden of young animals before your front door is in the browser game so far."));

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
}
