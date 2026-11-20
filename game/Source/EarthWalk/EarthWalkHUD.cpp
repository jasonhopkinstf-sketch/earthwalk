#include "EarthWalkHUD.h"

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
#include "Misc/ConfigCacheIni.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Styling/CoreStyle.h"
#include "Widgets/DeclarativeSyntaxSupport.h"
#include "Widgets/Input/SEditableTextBox.h"
#include "Widgets/Layout/SBox.h"
#include "Widgets/Layout/SScrollBox.h"
#include "Widgets/SBoxPanel.h"
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
	constexpr int32 MaxLines = 80;
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
				SNew(STextBlock)
				.Font(FCoreStyle::GetDefaultFontStyle("Regular", 10))
				.ColorAndOpacity(FLinearColor(1.f, 1.f, 1.f, 0.7f))
				.ShadowOffset(FVector2D(1.0, 1.0))
				.ShadowColorAndOpacity(FLinearColor(0.f, 0.f, 0.f, 0.85f))
				.Text(FText::FromString(FString::Printf(TEXT("EarthWalk %s  ·  Map data © OpenStreetMap contributors"), *GameVersion())))
			]
			+ SOverlay::Slot().HAlign(HAlign_Left).VAlign(VAlign_Bottom).Padding(16.f)
			[
				SNew(SBox).WidthOverride(560.f)
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
						.HintText(FText::FromString(TEXT("Press Enter to chat. Type /help for commands.")))
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
	TSharedPtr<SEditableTextBox> GetInput() const { return Input; }

	/** While the chat is closed the overlay ignores the pointer, so a stray click cannot steal the keyboard. */
	void SetHitTestable(bool bHitTestable) { SetVisibility(bHitTestable ? EVisibility::Visible : EVisibility::HitTestInvisible); }

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

	TWeakObjectPtr<AEarthWalkHUD> Owner;
	TSharedPtr<STextBlock> Status;
	TSharedPtr<SScrollBox> Log;
	TSharedPtr<SEditableTextBox> Input;
	TArray<TSharedRef<SWidget>> Lines;
};

void AEarthWalkHUD::BeginPlay()
{
	Super::BeginPlay();

	if (GEngine && GEngine->GameViewport)
	{
		SAssignNew(Overlay, SEarthWalkOverlay, this);
		Overlay->SetHitTestable(false);
		GEngine->GameViewport->AddViewportWidgetContent(Overlay.ToSharedRef(), 10);
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
		WelcomeHandle = Net->OnWelcome.AddWeakLambda(this, [this]()
		{
			// A signed-in player's animal comes from the account; show it.
			APlayerController* PC = GetOwningPlayerController();
			if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
			{
				Character->RefreshFigure();
			}
		});
	}

	ApplyGameInputMode(GetOwningPlayerController());
	AddLine(TEXT("Welcome to EarthWalk. WASD to move, drag or arrow keys to look, 2 to run, V for camera view, F to fly, Enter to chat. Try /goto Sydney Opera House."), NoticeColor);
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
	}
	if (Overlay.IsValid() && GEngine && GEngine->GameViewport)
	{
		GEngine->GameViewport->RemoveViewportWidgetContent(Overlay.ToSharedRef());
	}
	Overlay.Reset();
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
	if (!bChatOpen && FPlatformTime::Seconds() - ChatClosedAt > 0.2 && PC->WasInputKeyJustPressed(EKeys::Enter))
	{
		OpenChat();
	}

	StatusTimer -= DeltaSeconds;
	if (StatusTimer <= 0.f)
	{
		StatusTimer = 0.5f;
		Overlay->SetStatus(StatusText());
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

void AEarthWalkHUD::OpenChat()
{
	APlayerController* PC = GetOwningPlayerController();
	if (!PC || !Overlay.IsValid())
	{
		return;
	}
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
			Character->bTyping = false;
		}
		ApplyGameInputMode(PC);
	}
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
		if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
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

	if (Command == TEXT("help"))
	{
		AddLine(TEXT("/goto <place or lat, lon>   travel anywhere, e.g. /goto Times Square"), NoticeColor);
		AddLine(TEXT("/join <name>   go to someone in your room        /who   list who is here"), NoticeColor);
		AddLine(TEXT("/name <name>   /animal <fox, bear, rabbit, cat, owl or frog>   /room <room>"), NoticeColor);
		AddLine(TEXT("/server <address>   /code <access code>"), NoticeColor);
		AddLine(TEXT("/login   sign in with Google (opens your browser)        /logout   forget this sign-in"), NoticeColor);
		AddLine(TEXT("/home   make where you stand your home (or /home <place>); you start there next time"), NoticeColor);
		AddLine(TEXT("/where   show your coordinates        /fly   toggle flying (also the F key)"), NoticeColor);
		AddLine(TEXT("Keys: drag or arrows to look, 2 run / 1 walk (or hold Shift), V camera view, wheel zoom"), NoticeColor);
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
	else if (Command == TEXT("fly"))
	{
		if (Character)
		{
			Character->SetFlying(!Character->IsFlying());
		}
	}
	else if ((Command == TEXT("name") || Command == TEXT("animal") || Command == TEXT("room") || Command == TEXT("server") || Command == TEXT("code")) && !Argument.IsEmpty())
	{
		const TCHAR* Key = Command == TEXT("name") ? TEXT("Name") : Command == TEXT("animal") ? TEXT("Avatar") : Command == TEXT("room") ? TEXT("Room") : Command == TEXT("server") ? TEXT("Server") : TEXT("Code");
		FEarthWalkConfig::Save(Key, Argument);
		AddLine(TEXT("Saved. Reconnecting..."), NoticeColor);
		if (Net)
		{
			Net->Connect();
		}
		if (Command == TEXT("animal") && Character)
		{
			Character->RefreshFigure();
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
