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
				.Text(FText::FromString(TEXT("Map data © OpenStreetMap contributors")))
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
	}

	if (APlayerController* PC = GetOwningPlayerController())
	{
		PC->SetInputMode(FInputModeGameOnly());
		PC->bShowMouseCursor = false;
	}
	AddLine(TEXT("Welcome to EarthWalk. WASD to move, F to fly, Enter to chat. Try /goto Sydney Opera House."), NoticeColor);
}

void AEarthWalkHUD::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
	{
		Net->OnChat.Remove(ChatHandle);
		Net->OnNotice.Remove(NoticeHandle);
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
	if (APlayerController* PC = GetOwningPlayerController())
	{
		if (AEarthWalkCharacter* Character = Cast<AEarthWalkCharacter>(PC->GetPawn()))
		{
			Character->bTyping = false;
		}
		PC->SetInputMode(FInputModeGameOnly());
		PC->bShowMouseCursor = false;
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
		AddLine(TEXT("/name <name>   /room <room>   /server <address>   /code <access code>"), NoticeColor);
		AddLine(TEXT("/where   show your coordinates        /fly   toggle flying (also the F key)"), NoticeColor);
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
		TArray<FString> Names;
		if (Net)
		{
			for (const TPair<FString, FEarthPeer>& Pair : Net->GetPeers())
			{
				Names.Add(Pair.Value.Name);
			}
		}
		AddLine(Names.Num() ? FString::Printf(TEXT("Here with you: %s"), *FString::Join(Names, TEXT(", "))) : FString(TEXT("Nobody else is in this room right now.")), NoticeColor);
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
	else if ((Command == TEXT("name") || Command == TEXT("room") || Command == TEXT("server") || Command == TEXT("code")) && !Argument.IsEmpty())
	{
		const TCHAR* Key = Command == TEXT("name") ? TEXT("Name") : Command == TEXT("room") ? TEXT("Room") : Command == TEXT("server") ? TEXT("Server") : TEXT("Code");
		FEarthWalkConfig::Save(Key, Argument);
		AddLine(TEXT("Saved. Reconnecting..."), NoticeColor);
		if (Net)
		{
			Net->Connect();
		}
		if (Command == TEXT("server") && Character)
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
		AddLine(FString::Printf(TEXT("Nobody called \"%s\" is in this room. Type /who to see who is here."), *Name), ErrorColor);
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
	const FString Url = FString::Printf(TEXT("%s/v1/geocode?q=%s"), *FEarthWalkConfig::ServerUrl(), *FGenericPlatformHttp::UrlEncode(Query));
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(30.f);
	AddLine(FString::Printf(TEXT("Looking for \"%s\"..."), *Query), NoticeColor);
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Query](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
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
		AddLine(FString::Printf(TEXT("Travelling to %s"), *Name), NoticeColor);
		APlayerController* PC = GetOwningPlayerController();
		if (AEarthWalkCharacter* Character = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr)
		{
			Character->TeleportToGeo(Lat, Lon);
		}
	});
	Request->ProcessRequest();
}
