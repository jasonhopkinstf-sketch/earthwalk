#include "EarthLunch.h"

#include "Brushes/SlateRoundedBoxBrush.h"
#include "Dom/JsonObject.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWorld.h"
#include "Engine/Engine.h"
#include "Engine/GameInstance.h"
#include "Engine/GameViewportClient.h"
#include "GameFramework/PlayerController.h"
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
	/** How near a shop's name board the player must stand to buy there, and how near a friend to be given something: metres. As lunch.js. */
	constexpr double LunchShopM = 14.0;
	constexpr double LunchGiveM = 12.0;

	const FLinearColor LunchPanel(FColor(22, 28, 38, 240));
	const FLinearColor LunchDim(1.f, 1.f, 1.f, 0.62f);
	const FLinearColor LunchGold(FColor(245, 197, 24));
	const FLinearColor LunchEmpty(FColor(18, 24, 34, 200));

	/** The colour of each kind of good food's heart, and the short word under it. */
	FLinearColor LunchColour(const FString& Group)
	{
		return Group == TEXT("fruit") ? FLinearColor(FColor(214, 54, 64)) : Group == TEXT("veg") ? FLinearColor(FColor(52, 156, 70))
			: Group == TEXT("grain") ? FLinearColor(FColor(206, 150, 34)) : Group == TEXT("protein") ? FLinearColor(FColor(168, 100, 58))
			: FLinearColor(FColor(58, 140, 214));
	}
	const TCHAR* LunchWord(const FString& Group)
	{
		return Group == TEXT("fruit") ? TEXT("Fruit") : Group == TEXT("veg") ? TEXT("Veg") : Group == TEXT("grain") ? TEXT("Grains")
			: Group == TEXT("protein") ? TEXT("Protein") : Group == TEXT("dairy") ? TEXT("Dairy") : TEXT("Food");
	}
	/** "fruit and dairy" for what a food is good for; "a treat" for one that fills no heart. */
	FString LunchGoodFor(const TArray<FString>& Groups)
	{
		if (Groups.Num() == 0)
		{
			return TEXT("a treat");
		}
		TArray<FString> Words;
		for (const FString& Group : Groups)
		{
			Words.Add(FString(LunchWord(Group)).ToLower());
		}
		return FString::Join(Words, TEXT(" and "));
	}
	FString LunchCap(const FString& Text)
	{
		return Text.IsEmpty() ? Text : Text.Left(1).ToUpper() + Text.Mid(1);
	}

	FString FoodStr(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		FString Out;
		if (Json.IsValid())
		{
			Json->TryGetStringField(Field, Out);
		}
		return Out;
	}
	double FoodNum(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		double Out = 0.0;
		if (Json.IsValid())
		{
			Json->TryGetNumberField(Field, Out);
		}
		return Out;
	}
	bool FoodFlag(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
	{
		bool bOut = false;
		if (Json.IsValid())
		{
			Json->TryGetBoolField(Field, bOut);
		}
		return bOut;
	}
	TArray<TSharedPtr<FJsonObject>> FoodRows(const TSharedPtr<FJsonObject>& Json, const TCHAR* Field)
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
	TSharedPtr<FJsonObject> FoodOf(const TSharedPtr<FJsonObject>& Journal)
	{
		const TSharedPtr<FJsonObject>* Food = nullptr;
		return Journal.IsValid() && Journal->TryGetObjectField(TEXT("food"), Food) ? *Food : TSharedPtr<FJsonObject>();
	}

	TSharedRef<STextBlock> LunchLine(const FString& Text, const TCHAR* Face, int32 Size, const FLinearColor& Colour, float Wrap = 0.f)
	{
		return SNew(STextBlock).Font(FCoreStyle::GetDefaultFontStyle(Face, Size)).ColorAndOpacity(Colour).WrapTextAt(Wrap).Text(FText::FromString(Text));
	}
}

/** The five hearts in the corner, and the lunch box in the middle of the screen. */
class SEarthLunchView : public SCompoundWidget
{
public:
	SLATE_BEGIN_ARGS(SEarthLunchView) {}
	SLATE_END_ARGS()

	void Construct(const FArguments&, UEarthLunch* InOwner)
	{
		Owner = InOwner;
		SetVisibility(EVisibility::SelfHitTestInvisible);
		const TWeakObjectPtr<UEarthLunch> Lunch = Owner;
		ChildSlot
		[
			SNew(SOverlay)
			// The hearts: under the line at the top left that says where the player is. A click opens the lunch box.
			+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Top).Padding(12.f, 40.f, 0.f, 0.f)
			[
				SAssignNew(HeartsButton, SButton)
				.IsFocusable(false)
				.ButtonStyle(&Clear)
				.ContentPadding(FMargin(4.f, 3.f))
				.Visibility(EVisibility::Collapsed)
				.OnClicked_Lambda([Lunch]()
				{
					if (UEarthLunch* Box = Lunch.Get())
					{
						Box->Toggle();
					}
					return FReply::Handled();
				})
				[
					SAssignNew(HeartsRow, SHorizontalBox)
				]
			]
			+ SOverlay::Slot().HAlign(HAlign_Center).VAlign(VAlign_Center)
			[
				SAssignNew(Panel, SBorder)
				.BorderImage(&PanelBrush)
				.BorderBackgroundColor(LunchPanel)
				.Padding(FMargin(26.f, 18.f, 26.f, 20.f))
				.Visibility(EVisibility::Collapsed)
				[
					SNew(SBox).WidthOverride(600.f)
					[
						SNew(SVerticalBox)
						+ SVerticalBox::Slot().AutoHeight()
						[
							SNew(SHorizontalBox)
							+ SHorizontalBox::Slot().FillWidth(1.f)[LunchLine(TEXT("Your lunch box"), TEXT("Bold"), 24, FLinearColor::White)]
							+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)[LunchLine(TEXT("B or Esc to close"), TEXT("Regular"), 10, LunchDim)]
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

	/** One heart: its colour when it is full, dark when it is not, with the kind of food under its name. */
	TSharedRef<SWidget> Heart(const FString& Group, const FString& Words, bool bFull, int32 Size)
	{
		return SNew(SBorder)
			.BorderImage(&Pill)
			.BorderBackgroundColor(bFull ? LunchColour(Group) : LunchEmpty)
			.Padding(FMargin(9.f, 3.f, 10.f, 4.f))
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center).Padding(0.f, 0.f, 5.f, 0.f)
				[
					LunchLine(TEXT("♥"), TEXT("Bold"), Size + 2, bFull ? FLinearColor::White : LunchColour(Group))
				]
				+ SHorizontalBox::Slot().AutoWidth().VAlign(VAlign_Center)
				[
					LunchLine(Words, TEXT("Bold"), Size, bFull ? FLinearColor::White : LunchDim)
				]
			];
	}

	/** A line of the lunch box that does something: what it is in bold, a few words under it, and what a click does. */
	TSharedRef<SWidget> Row(const FString& Title, const FString& Sub, bool bEnabled, TFunction<void()> Do)
	{
		return SNew(SButton)
			.IsFocusable(false)
			.IsEnabled(bEnabled)
			.ButtonStyle(&RowButton)
			.ContentPadding(FMargin(12.f, 6.f))
			.OnClicked_Lambda([Do]()
			{
				Do();
				return FReply::Handled();
			})
			[
				SNew(SVerticalBox)
				+ SVerticalBox::Slot().AutoHeight()[LunchLine(Title, TEXT("Bold"), 13, bEnabled ? FLinearColor::White : LunchDim)]
				+ SVerticalBox::Slot().AutoHeight()[LunchLine(Sub, TEXT("Regular"), 10, LunchDim)]
			];
	}

	TWeakObjectPtr<UEarthLunch> Owner;
	TSharedPtr<SButton> HeartsButton;
	TSharedPtr<SHorizontalBox> HeartsRow;
	TSharedPtr<SBorder> Panel;
	TSharedPtr<SScrollBox> Body;

	FSlateRoundedBoxBrush PanelBrush = FSlateRoundedBoxBrush(FLinearColor::White, 12.f);
	FSlateRoundedBoxBrush Pill = FSlateRoundedBoxBrush(FLinearColor::White, 11.f);
	FButtonStyle Clear = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(0.f, 0.f, 0.f, 0.f), 12.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 40)), 12.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 70)), 12.f));
	FButtonStyle RowButton = FButtonStyle()
		.SetNormal(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 16)), 8.f))
		.SetHovered(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 150)), 8.f))
		.SetPressed(FSlateRoundedBoxBrush(FLinearColor(FColor(70, 130, 220, 210)), 8.f))
		.SetDisabled(FSlateRoundedBoxBrush(FLinearColor(FColor(255, 255, 255, 8)), 8.f));
};

UEarthWalkNet* UEarthLunch::Room() const
{
	const AEarthWalkHUD* Screen = Hud.Get();
	return Screen && Screen->GetGameInstance() ? Screen->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
}

void UEarthLunch::Setup(AEarthWalkHUD* InHud)
{
	if (!InHud || !GEngine || !GEngine->GameViewport)
	{
		return;
	}
	Hud = InHud;
	SAssignNew(View, SEarthLunchView, this);
	// Under the menu and the passport, over the little map.
	GEngine->GameViewport->AddViewportWidgetContent(View.ToSharedRef(), 10);

	if (UEarthWalkNet* Net = Room())
	{
		JournalHandle = Net->OnJournal.AddWeakLambda(this, [this](const TSharedPtr<FJsonObject>& InJournal)
		{
			if (InJournal.IsValid())
			{
				Journal = InJournal;
				DrawHearts();
				if (bOpen)
				{
					Redraw();
				}
			}
		});
		MenuHandle = Net->OnMenu.AddWeakLambda(this, [this](const FEarthMenu& InMenu)
		{
			Menu = InMenu;
			bMenu = true;
			if (bOpen)
			{
				Redraw();
			}
		});
		PepHandle = Net->OnPep.AddWeakLambda(this, [this](bool bOn)
		{
			const AEarthWalkHUD* Screen = Hud.Get();
			const APlayerController* PC = Screen ? Screen->GetOwningPlayerController() : nullptr;
			if (AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
			{
				Me->SetPep(bOn);
			}
		});
		// The hearts are shown from the start, and kept up with whatever is given or eaten.
		WelcomeHandle = Net->OnWelcome.AddWeakLambda(this, [this]()
		{
			AskJournalAt = FPlatformTime::Seconds() + 1.5;
		});
		StampHandle = Net->OnStamp.AddWeakLambda(this, [this](const FString& Kind, const FString&, const FString&)
		{
			if (Kind == TEXT("food") || Kind == TEXT("care") || Kind == TEXT("favour"))
			{
				AskJournalAt = FPlatformTime::Seconds() + 0.2;
			}
		});
		if (Net->IsConnected())
		{
			AskJournalAt = FPlatformTime::Seconds() + 1.5;
		}
	}
}

void UEarthLunch::Shutdown()
{
	if (UEarthWalkNet* Net = Room())
	{
		Net->OnJournal.Remove(JournalHandle);
		Net->OnMenu.Remove(MenuHandle);
		Net->OnPep.Remove(PepHandle);
		Net->OnWelcome.Remove(WelcomeHandle);
		Net->OnStamp.Remove(StampHandle);
	}
	if (View.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(View.ToSharedRef());
	}
	View.Reset();
	Journal.Reset();
}

void UEarthLunch::Toggle()
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
	View->Panel->SetVisibility(EVisibility::Visible);
	if (UEarthWalkNet* Net = Room())
	{
		Net->RequestJournal();
	}
	AskMenu();
	Redraw();
}

void UEarthLunch::Close()
{
	bOpen = false;
	if (View.IsValid())
	{
		View->Panel->SetVisibility(EVisibility::Collapsed);
	}
}

void UEarthLunch::AskMenu()
{
	bMenu = false;
	if (bShop)
	{
		if (UEarthWalkNet* Net = Room())
		{
			Net->SendFood(TEXT("menu"), ShopUse);
		}
	}
}

void UEarthLunch::Eat(const FString& Id)
{
	if (UEarthWalkNet* Net = Room())
	{
		Net->SendFood(TEXT("eat"), Id);
	}
}

void UEarthLunch::Buy(const FString& Id)
{
	if (UEarthWalkNet* Net = Room(); Net && bShop)
	{
		Net->SendFood(TEXT("buy"), Id, ShopUse);
	}
}

void UEarthLunch::Cook(const FString& Id)
{
	if (UEarthWalkNet* Net = Room())
	{
		Net->SendFood(TEXT("cook"), Id);
	}
}

void UEarthLunch::Give(const FString& Id)
{
	if (UEarthWalkNet* Net = Room(); Net && !FriendId.IsEmpty())
	{
		Net->SendFood(TEXT("give"), Id, FriendId);
	}
}

void UEarthLunch::Frame(float DeltaSeconds)
{
	UEarthWalkNet* Net = Room();
	const AEarthWalkHUD* Screen = Hud.Get();
	if (!Net || !Screen || !View.IsValid())
	{
		return;
	}
	const double Now = FPlatformTime::Seconds();
	if (AskJournalAt > 0.0 && Now > AskJournalAt && Net->IsConnected())
	{
		AskJournalAt = 0.0;
		Net->RequestJournal();
	}
	if ((SinceScan += DeltaSeconds) < 0.3)
	{
		return;
	}
	SinceScan = 0.0;
	const APlayerController* PC = Screen->GetOwningPlayerController();
	const AEarthWalkCharacter* Me = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	const AEarthWorld* Earth = AEarthWorld::Get(Screen);
	if (!Me || !Earth)
	{
		return;
	}
	const FVector Here = Me->GetActorLocation();
	const double Px = Here.Y / 100.0, Pz = -Here.X / 100.0;

	// Is there a shop or somewhere to eat within reach?
	TArray<FEarthShop> Shops;
	Earth->ShopsNear(Px, Pz, LunchShopM, Shops);
	const FEarthShop* Best = nullptr;
	double BestD = LunchShopM;
	for (const FEarthShop& Shop : Shops)
	{
		const double D = FMath::Sqrt(FMath::Square(Shop.X - Px) + FMath::Square(Shop.Z - Pz));
		if (D < BestD)
		{
			BestD = D;
			Best = &Shop;
		}
	}
	// And is a friend near enough to be given something?
	FString NearId, NearName;
	double NearD = LunchGiveM;
	for (const TPair<FString, FEarthPeer>& Pair : Net->GetPeers())
	{
		if (!Pair.Value.bHasPosition)
		{
			continue;
		}
		const FVector At = Earth->GeoToWorld(Pair.Value.Lat, Pair.Value.Lon, 0.0);
		const double D = FMath::Sqrt(FMath::Square(At.Y / 100.0 - Px) + FMath::Square(-At.X / 100.0 - Pz));
		if (D < NearD)
		{
			NearD = D;
			NearId = Pair.Key;
			NearName = Pair.Value.Name;
		}
	}
	const bool bHomeNow = AtHome && AtHome();
	const bool bFriendChanged = NearId != FriendId || bHomeNow != bHome;
	bHome = bHomeNow;
	FriendId = NearId;
	FriendName = NearName;
	const bool bShopChanged = (Best != nullptr) != bShop || (Best && (Best->Text != ShopText || Best->Use != ShopUse));
	if (bShopChanged)
	{
		bShop = Best != nullptr;
		ShopText = Best ? Best->Text : FString();
		ShopUse = Best ? Best->Use : FString();
		if (bOpen)
		{
			AskMenu();
			Redraw();
		}
	}
	else if (bFriendChanged && bOpen)
	{
		Redraw();
	}
	Hint = bShop ? FString::Printf(TEXT("B: buy food at %s"), *ShopText) : FString();
}

void UEarthLunch::DrawHearts()
{
	const TSharedPtr<FJsonObject> Food = FoodOf(Journal);
	if (!Food.IsValid() || !View.IsValid())
	{
		return;
	}
	View->HeartsRow->ClearChildren();
	for (const TSharedPtr<FJsonObject>& Heart : FoodRows(Food, TEXT("hearts")))
	{
		const FString Group = FoodStr(Heart, TEXT("group"));
		View->HeartsRow->AddSlot().AutoWidth().Padding(0.f, 0.f, 4.f, 0.f)[View->Heart(Group, LunchWord(Group), FoodFlag(Heart, TEXT("full")), 9)];
	}
	View->HeartsButton->SetVisibility(EVisibility::Visible);
	View->HeartsButton->SetToolTipText(FText::FromString(FoodFlag(Food, TEXT("full"))
		? TEXT("All five hearts are full: you are quicker on your feet today (B opens your lunch box)")
		: TEXT("Your five hearts: eat each kind of good food to fill them (B opens your lunch box)")));
}

void UEarthLunch::Redraw()
{
	if (!View.IsValid())
	{
		return;
	}
	const TSharedPtr<SScrollBox> Body = View->Body;
	const float Scrolled = Body->GetScrollOffset();
	Body->ClearChildren();
	const TSharedPtr<FJsonObject> Food = FoodOf(Journal);
	if (!Food.IsValid())
	{
		Body->AddSlot()[LunchLine(TEXT("Opening it..."), TEXT("Regular"), 12, LunchDim)];
		return;
	}
	const TWeakObjectPtr<UEarthLunch> Self = this;
	const auto Heading = [&Body](const FString& Text)
	{
		Body->AddSlot().Padding(2.f, 14.f, 0.f, 6.f)[LunchLine(Text.ToUpper(), TEXT("Bold"), 11, LunchGold)];
	};
	const auto Note = [&Body](const FString& Text)
	{
		Body->AddSlot().Padding(2.f, 2.f, 0.f, 2.f)[LunchLine(Text, TEXT("Regular"), 11, LunchDim, 580.f)];
	};

	// The five hearts, each with the kind of food that fills it.
	const TSharedRef<SWrapBox> Hearts = SNew(SWrapBox).UseAllottedSize(true).InnerSlotPadding(FVector2D(6.0, 6.0));
	for (const TSharedPtr<FJsonObject>& Heart : FoodRows(Food, TEXT("hearts")))
	{
		Hearts->AddSlot()[View->Heart(FoodStr(Heart, TEXT("group")), FoodStr(Heart, TEXT("title")), FoodFlag(Heart, TEXT("full")), 11)];
	}
	Body->AddSlot().Padding(0.f, 2.f, 0.f, 6.f)[Hearts];
	Note(FoodFlag(Food, TEXT("full"))
		? FString(TEXT("All five hearts are full. You are full of beans: quicker on your feet until tomorrow."))
		: FString::Printf(TEXT("Eat one of each kind of good food to fill all five hearts: you will be quicker on your feet, and get %d coins. Nothing is lost if you do not."), FMath::RoundToInt32(FoodNum(Food, TEXT("coinsFull")))));

	// What is carried: a click eats it; with a friend standing by, another gives it.
	const TArray<TSharedPtr<FJsonObject>> Larder = FoodRows(Food, TEXT("larder"));
	int32 Carried = 0;
	for (const TSharedPtr<FJsonObject>& Thing : Larder)
	{
		Carried += FMath::RoundToInt32(FoodNum(Thing, TEXT("n")));
	}
	const int32 RoomLeft = FMath::RoundToInt32(FoodNum(Food, TEXT("room")));
	Heading(FString::Printf(TEXT("In the box (%d of %d)"), Carried, Carried + RoomLeft));
	for (const TSharedPtr<FJsonObject>& Thing : Larder)
	{
		const FString Id = FoodStr(Thing, TEXT("id"));
		const int32 N = FMath::RoundToInt32(FoodNum(Thing, TEXT("n")));
		TArray<FString> Groups;
		Thing->TryGetStringArrayField(TEXT("groups"), Groups);
		const FString Title = N > 1 ? FString::Printf(TEXT("%s  ×%d"), *LunchCap(FoodStr(Thing, TEXT("name"))), N) : LunchCap(FoodStr(Thing, TEXT("name")));
		const TSharedRef<SWidget> EatIt = View->Row(Title, FString::Printf(TEXT("Eat it  ·  good for %s"), *LunchGoodFor(Groups)), true, [Self, Id]()
		{
			if (UEarthLunch* Box = Self.Get())
			{
				Box->Eat(Id);
			}
		});
		if (FriendId.IsEmpty())
		{
			Body->AddSlot().Padding(0.f, 0.f, 0.f, 4.f)[EatIt];
		}
		else
		{
			Body->AddSlot().Padding(0.f, 0.f, 0.f, 4.f)
			[
				SNew(SHorizontalBox)
				+ SHorizontalBox::Slot().FillWidth(1.f)[EatIt]
				+ SHorizontalBox::Slot().AutoWidth().Padding(6.f, 0.f, 0.f, 0.f)
				[
					View->Row(FString::Printf(TEXT("Give to %s"), *FriendName), TEXT("They are standing by"), true, [Self, Id]()
					{
						if (UEarthLunch* Box = Self.Get())
						{
							Box->Give(Id);
						}
					})
				]
			];
		}
	}
	if (Larder.Num() == 0)
	{
		Note(TEXT("Empty. Talk (T) to a cow, a hen, a fruit tree, a tractor or a boat and it may give you something; or buy food at a real shop or café."));
	}

	// At home: the kitchen, and the recipes that are known.
	const TArray<TSharedPtr<FJsonObject>> Recipes = FoodRows(Food, TEXT("recipes"));
	if (bHome && Recipes.Num() > 0)
	{
		int32 Known = 0;
		for (const TSharedPtr<FJsonObject>& Recipe : Recipes)
		{
			Known += FoodFlag(Recipe, TEXT("known")) ? 1 : 0;
		}
		Heading(FString::Printf(TEXT("Your kitchen (%d of %d recipes)"), Known, Recipes.Num()));
		for (const TSharedPtr<FJsonObject>& Recipe : Recipes)
		{
			if (!FoodFlag(Recipe, TEXT("known")))
			{
				continue;
			}
			const FString Id = FoodStr(Recipe, TEXT("id"));
			TArray<FString> Groups, Needs;
			Recipe->TryGetStringArrayField(TEXT("groups"), Groups);
			for (const TSharedPtr<FJsonObject>& Need : FoodRows(Recipe, TEXT("needs")))
			{
				Needs.Add(FoodStr(Need, TEXT("name")) + (FoodFlag(Need, TEXT("have")) ? TEXT("") : TEXT(" (not in the box)")));
			}
			Body->AddSlot().Padding(0.f, 0.f, 0.f, 4.f)
			[
				View->Row(FString::Printf(TEXT("%s  \u00d7%d  \u00b7  good for %s"), *LunchCap(FoodStr(Recipe, TEXT("name"))), FMath::RoundToInt32(FoodNum(Recipe, TEXT("makes"))), *LunchGoodFor(Groups)),
					FString::Printf(TEXT("Cook it from %s"), *FString::Join(Needs, TEXT(" + "))), FoodFlag(Recipe, TEXT("can")), [Self, Id]()
				{
					if (UEarthLunch* Box = Self.Get())
					{
						Box->Cook(Id);
					}
				})
			];
		}
		if (Known < Recipes.Num())
		{
			Note(TEXT("Cook something you have not cooked before, and you learn the next recipe in the book."));
		}
	}
	else if (Recipes.Num() > 0 && !bShop)
	{
		Note(TEXT("In a house of your own (H) this is a kitchen too: recipes turn what you carry into meals, two helpings at a time."));
	}
	// Beside a shop or a café: what it sells.
	if (bShop)
	{
		const int32 Coins = FMath::RoundToInt32(FoodNum(Journal, TEXT("coins")));
		Heading(FString::Printf(TEXT("%s sells"), *ShopText));
		FString Purse = FString::Printf(TEXT("%d coin%s to spend"), Coins, Coins == 1 ? TEXT("") : TEXT("s"));
		if (bMenu && !Menu.Country.IsEmpty() && ShopUse == TEXT("food"))
		{
			const bool bThe = Menu.Country.StartsWith(TEXT("Netherlands")) || Menu.Country.StartsWith(TEXT("United ")) || Menu.Country.StartsWith(TEXT("Philippines")) || Menu.Country.StartsWith(TEXT("Czech Republic"));
			Purse += FString::Printf(TEXT("  ·  the food of %s%s"), bThe ? TEXT("the ") : TEXT(""), *Menu.Country);
		}
		Note(Purse);
		if (!bMenu)
		{
			Note(TEXT("Asking what there is..."));
		}
		else
		{
			for (const FEarthFood& Dish : Menu.Items)
			{
				const FString Id = Dish.Id;
				Body->AddSlot().Padding(0.f, 0.f, 0.f, 4.f)
				[
					View->Row(LunchCap(Dish.Name), FString::Printf(TEXT("%d coins  ·  good for %s"), Dish.Price, *LunchGoodFor(Dish.Groups)), Coins >= Dish.Price && RoomLeft > 0, [Self, Id]()
					{
						if (UEarthLunch* Box = Self.Get())
						{
							Box->Buy(Id);
						}
					})
				];
			}
		}
	}
	else
	{
		Note(TEXT("Stand by a real shop or café with its name on a board, and B shows what it sells. Each country has its own food."));
	}
	Body->SetScrollOffset(Scrolled);
}
