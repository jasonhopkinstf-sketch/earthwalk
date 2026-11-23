#include "EarthWalkNet.h"

#include "EarthWalkSettings.h"
#include "Dom/JsonObject.h"
#include "GenericPlatform/GenericPlatformHttp.h"
#include "HAL/PlatformProcess.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "IWebSocket.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"

namespace
{
	constexpr double LinkPollSeconds = 2.0;
	constexpr double LinkTimeoutSeconds = 600.0;
}

double UEarthWalkNet::LocalNow()
{
	// The date is read once and the stopwatch does the rest, so the clock runs evenly.
	static const double StartedAt = FPlatformTime::Seconds();
	static const double DateThen = static_cast<double>(FDateTime::UtcNow().GetTicks() - FDateTime(1970, 1, 1).GetTicks()) / ETimespan::TicksPerSecond;
	return DateThen + (FPlatformTime::Seconds() - StartedAt);
}

void UEarthWalkNet::StopClock()
{
	FTSTicker::GetCoreTicker().RemoveTicker(ClockHandle);
	ClockHandle.Reset();
}

void UEarthWalkNet::AskTime()
{
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("time"));
	Message->SetNumberField(TEXT("c"), FPlatformTime::Seconds() * 1000.0); // our stopwatch, sent back unchanged
	SendJson(Message);
}

/** Asks the server the time a few times now, and once a minute after. The quickest answer is the truest. */
void UEarthWalkNet::SyncClock()
{
	StopClock();
	ClockAsks = 0;
	TWeakObjectPtr<UEarthWalkNet> WeakThis(this);
	ClockHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakThis](float)
	{
		UEarthWalkNet* Self = WeakThis.Get();
		if (!Self)
		{
			return false;
		}
		// Half a second after the welcome, then at 1.5, 3 and 6 seconds, then every minute.
		static const double Times[] = { 0.5, 1.5, 3.0, 6.0 };
		const double Since = FPlatformTime::Seconds() - Self->ClockStartedAt;
		const double Due = Self->ClockAsks < 4 ? Times[Self->ClockAsks] : 6.0 + (Self->ClockAsks - 3) * 60.0;
		if (Since >= Due && Self->bJoined)
		{
			if (Self->ClockAsks >= 4)
			{
				Self->ClockTripMs *= 1.2; // an old measurement slowly gives way to a fresh one
			}
			++Self->ClockAsks;
			Self->AskTime();
		}
		return true;
	}), 0.25f);
}

void UEarthWalkNet::Deinitialize()
{
	StopClock();
	StopLogin();
	Disconnect();
	Super::Deinitialize();
}

void UEarthWalkNet::Disconnect()
{
	bWantConnection = false;
	bJoined = false;
	StopClock();
	FTSTicker::GetCoreTicker().RemoveTicker(RetryHandle);
	RetryHandle.Reset();
	if (Socket.IsValid())
	{
		Socket->OnConnected().Clear();
		Socket->OnConnectionError().Clear();
		Socket->OnClosed().Clear();
		Socket->OnMessage().Clear();
		Socket->Close();
		Socket.Reset();
	}
	Peers.Reset();
}

void UEarthWalkNet::Connect()
{
	Disconnect();
	bWantConnection = true;
	bDenied = false;

	FString Url = FEarthWalkConfig::ServerUrl();
	if (Url.StartsWith(TEXT("https://")))
	{
		Url = TEXT("wss://") + Url.RightChop(8);
	}
	else if (Url.StartsWith(TEXT("http://")))
	{
		Url = TEXT("ws://") + Url.RightChop(7);
	}
	Url += TEXT("/v1/ws");

	FWebSocketsModule& Module = FModuleManager::LoadModuleChecked<FWebSocketsModule>(TEXT("WebSockets"));
	Socket = Module.CreateWebSocket(Url, FString());

	TWeakObjectPtr<UEarthWalkNet> WeakThis(this);
	Socket->OnConnected().AddLambda([WeakThis]()
	{
		if (UEarthWalkNet* Self = WeakThis.Get())
		{
			const TSharedRef<FJsonObject> Hello = MakeShared<FJsonObject>();
			Hello->SetStringField(TEXT("t"), TEXT("hello"));
			Hello->SetStringField(TEXT("room"), FEarthWalkConfig::Room());
			// How far this PC's clock is ahead of UTC, in minutes: the day's tasks turn over at the player's own midnight.
			Hello->SetNumberField(TEXT("tz"), FMath::RoundToDouble((FDateTime::Now() - FDateTime::UtcNow()).GetTotalMinutes()));
			// A signed-in player's name and animal live on the account; only send them when the
			// player set them on this device (/name, /animal), which then updates the account.
			FString Override;
			const bool bSignedIn = FEarthWalkConfig::IsSignedIn();
			if (!bSignedIn || FEarthWalkConfig::HasOverride(TEXT("Name"), Override))
			{
				Hello->SetStringField(TEXT("name"), FEarthWalkConfig::PlayerName());
			}
			if (!bSignedIn || FEarthWalkConfig::HasOverride(TEXT("Avatar"), Override))
			{
				Hello->SetStringField(TEXT("avatar"), FEarthWalkConfig::Avatar());
			}
			const FString Code = FEarthWalkConfig::AccessCode(); // the player token when signed in
			if (!Code.IsEmpty())
			{
				Hello->SetStringField(TEXT("token"), Code);
			}
			Self->SendJson(Hello);
		}
	});
	Socket->OnConnectionError().AddLambda([WeakThis](const FString& Error)
	{
		if (UEarthWalkNet* Self = WeakThis.Get())
		{
			Self->HandleDropped(Error);
		}
	});
	Socket->OnClosed().AddLambda([WeakThis](int32 /*StatusCode*/, const FString& Reason, bool /*bWasClean*/)
	{
		if (UEarthWalkNet* Self = WeakThis.Get())
		{
			Self->HandleDropped(Reason);
		}
	});
	Socket->OnMessage().AddLambda([WeakThis](const FString& Message)
	{
		if (UEarthWalkNet* Self = WeakThis.Get())
		{
			Self->HandleMessage(Message);
		}
	});
	Socket->Connect();
}

void UEarthWalkNet::HandleDropped(const FString& Why)
{
	const bool bWasJoined = bJoined;
	bJoined = false;
	Peers.Reset();
	if (bWasJoined)
	{
		OnNotice.Broadcast(TEXT("Lost connection to the meetup server. Reconnecting..."));
	}
	UE_LOG(LogTemp, Log, TEXT("EarthWalk: meetup connection dropped (%s)"), *Why);

	// Retry quietly every few seconds, unless the server refused us (wrong access code, room full).
	if (bWantConnection && !bDenied && !RetryHandle.IsValid())
	{
		TWeakObjectPtr<UEarthWalkNet> WeakThis(this);
		RetryHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakThis](float)
		{
			if (UEarthWalkNet* Self = WeakThis.Get())
			{
				Self->RetryHandle.Reset();
				if (Self->bWantConnection)
				{
					Self->Connect();
				}
			}
			return false;
		}), 5.0f);
	}
}

void UEarthWalkNet::SendJson(const TSharedRef<FJsonObject>& Object)
{
	if (!Socket.IsValid() || !Socket->IsConnected())
	{
		return;
	}
	FString Out;
	const TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
		TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
	FJsonSerializer::Serialize(Object, Writer);
	Socket->Send(Out);
}

void UEarthWalkNet::SendPosition(double Lat, double Lon, double Alt, double Yaw, bool bFlown)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("pos"));
	Message->SetNumberField(TEXT("lat"), Lat);
	Message->SetNumberField(TEXT("lon"), Lon);
	Message->SetNumberField(TEXT("alt"), Alt);
	Message->SetNumberField(TEXT("yaw"), Yaw);
	if (bFlown)
	{
		Message->SetBoolField(TEXT("flown"), true); // being flown somewhere: not a walk, and no map is wanted ahead of it
	}
	SendJson(Message);
}

void UEarthWalkNet::SendRide(uint32 Thing, const FString& Sp)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("ride"));
	Message->SetNumberField(TEXT("thing"), static_cast<double>(Thing));
	Message->SetStringField(TEXT("sp"), Sp);
	SendJson(Message);
}

void UEarthWalkNet::SendDismount()
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("ride"));
	SendJson(Message);
}

void UEarthWalkNet::SendTalk(uint32 Thing, const FString& Sp, const FString& Text, bool bHasAt, double Lat, double Lon)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("talk"));
	Message->SetNumberField(TEXT("thing"), static_cast<double>(Thing));
	Message->SetStringField(TEXT("sp"), Sp);
	if (!Text.IsEmpty())
	{
		Message->SetStringField(TEXT("text"), Text.Left(200));
	}
	if (bHasAt)
	{
		Message->SetNumberField(TEXT("lat"), FMath::RoundToDouble(Lat * 1e7) / 1e7);
		Message->SetNumberField(TEXT("lon"), FMath::RoundToDouble(Lon * 1e7) / 1e7);
	}
	SendJson(Message);
}

void UEarthWalkNet::SendTalkInside(uint32 Thing, const FString& Sp, const FString& Text, const FString& Role, FIntPoint Chunk, int64 Building)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("talk"));
	Message->SetNumberField(TEXT("thing"), static_cast<double>(Thing));
	Message->SetStringField(TEXT("sp"), Sp);
	if (!Text.IsEmpty())
	{
		Message->SetStringField(TEXT("text"), Text.Left(200));
	}
	Message->SetStringField(TEXT("role"), Role);
	const TSharedRef<FJsonObject> At = MakeShared<FJsonObject>();
	At->SetNumberField(TEXT("x"), ((Chunk.X % 65536) + 65536) % 65536);
	At->SetNumberField(TEXT("y"), Chunk.Y);
	At->SetNumberField(TEXT("id"), static_cast<double>(Building));
	Message->SetObjectField(TEXT("at"), At);
	SendJson(Message);
}

bool UEarthWalkNet::ReadLevel(const FJsonObject& Json, FEarthLevel& Out)
{
	double Number = 0.0;
	if (!Json.TryGetNumberField(TEXT("n"), Number) || !Json.TryGetNumberField(TEXT("points"), Out.Points))
	{
		return false;
	}
	Out.N = FMath::RoundToInt32(Number);
	Json.TryGetStringField(TEXT("title"), Out.Title);
	Json.TryGetNumberField(TEXT("from"), Out.From);
	Json.TryGetNumberField(TEXT("next"), Out.Next);
	Json.TryGetStringField(TEXT("hint"), Out.Hint);
	return true;
}

void UEarthWalkNet::RequestJournal()
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server, so there is no passport to open yet."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("journal"));
	SendJson(Message);
}

void UEarthWalkNet::SendPet(const FString& Sp)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("pet"));
	if (!Sp.IsEmpty())
	{
		Message->SetStringField(TEXT("sp"), Sp);
	}
	SendJson(Message);
}

void UEarthWalkNet::SendHatBuy(const FString& Id)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("hat"));
	Message->SetStringField(TEXT("buy"), Id);
	SendJson(Message);
}

void UEarthWalkNet::SendHatWear(const FString& Id)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("hat"));
	if (!Id.IsEmpty())
	{
		Message->SetStringField(TEXT("wear"), Id);
	}
	SendJson(Message);
}

void UEarthWalkNet::SendExpedition(const FString& Id, bool bStart)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("expedition"));
	Message->SetStringField(bStart ? TEXT("start") : TEXT("drop"), Id);
	SendJson(Message);
}

void UEarthWalkNet::SendFavourDrop(const FString& Id)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("favour"));
	Message->SetStringField(TEXT("drop"), Id);
	SendJson(Message);
}

void UEarthWalkNet::SendGarage(const FString& What, const FString& Id)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server, so your car cannot come yet."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("garage"));
	if (What == TEXT("paint") || What == TEXT("body"))
	{
		Message->SetStringField(What, Id);
	}
	else
	{
		Message->SetBoolField(What, true); // call, away
	}
	SendJson(Message);
}

void UEarthWalkNet::SendRace(const FString& What)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("race"));
	Message->SetBoolField(What, true);
	SendJson(Message);
}

void UEarthWalkNet::SendAgility()
{
	if (bJoined)
	{
		const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
		Message->SetStringField(TEXT("t"), TEXT("race"));
		Message->SetStringField(TEXT("make"), TEXT("agility"));
		SendJson(Message);
	}
}

void UEarthWalkNet::SendTrick(const FString& Verb, const FString& Trick)
{
	if (bJoined)
	{
		const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
		Message->SetStringField(TEXT("t"), TEXT("trick"));
		Message->SetStringField(Verb, Trick.Left(40));
		SendJson(Message);
	}
}

void UEarthWalkNet::SendTrickPresses(const TArray<int32>& Presses)
{
	if (bJoined)
	{
		TArray<TSharedPtr<FJsonValue>> Values;
		for (const int32 Press : Presses)
		{
			Values.Add(MakeShared<FJsonValueNumber>(Press));
		}
		const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
		Message->SetStringField(TEXT("t"), TEXT("trick"));
		Message->SetArrayField(TEXT("presses"), Values);
		SendJson(Message);
	}
}

void UEarthWalkNet::SendGarden(const FString& Verb, const FString& Sp, int32 Index)
{
	if (bJoined)
	{
		const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
		Message->SetStringField(TEXT("t"), TEXT("garden"));
		if (Verb == TEXT("adopt"))
		{
			Message->SetStringField(Verb, Sp);
		}
		else
		{
			Message->SetNumberField(Verb, Index);
		}
		SendJson(Message);
	}
}

void UEarthWalkNet::SendPlay(const FString& Verb, const FString& Kind)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("play"));
	if (Verb == TEXT("make"))
	{
		Message->SetStringField(TEXT("make"), Kind);
	}
	else
	{
		Message->SetBoolField(Verb, true); // join, go, stop
	}
	SendJson(Message);
}

void UEarthWalkNet::SendTaxi(const FString& Place, bool bAt, double Lat, double Lon)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server, so no taxi can come yet."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("taxi"));
	Message->SetStringField(TEXT("place"), Place.Left(120));
	if (bAt)
	{
		Message->SetNumberField(TEXT("lat"), Lat);
		Message->SetNumberField(TEXT("lon"), Lon);
	}
	SendJson(Message);
}

void UEarthWalkNet::SendGuide(const FString& Question)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server, so the guide cannot hear you yet."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("guide"));
	Message->SetStringField(TEXT("q"), Question.Left(200));
	SendJson(Message);
}

void UEarthWalkNet::SendGuideTake(const FString& Name, double Lat, double Lon)
{
	if (!bJoined)
	{
		return;
	}
	const TSharedRef<FJsonObject> Take = MakeShared<FJsonObject>();
	Take->SetStringField(TEXT("name"), Name);
	Take->SetNumberField(TEXT("lat"), Lat);
	Take->SetNumberField(TEXT("lon"), Lon);
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("guide"));
	Message->SetObjectField(TEXT("take"), Take);
	SendJson(Message);
}

void UEarthWalkNet::SendFood(const FString& Verb, const FString& What, const FString& With)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server just now, so the lunch box is shut."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("food"));
	Message->SetStringField(Verb, What.Left(60));
	if (!With.IsEmpty())
	{
		Message->SetStringField(Verb == TEXT("give") ? TEXT("to") : TEXT("at"), With.Left(80));
	}
	SendJson(Message);
}

void UEarthWalkNet::SendHouse(const TSharedRef<FJsonObject>& Body)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server just now, so nothing can be done about a house."));
		return;
	}
	Body->SetStringField(TEXT("t"), TEXT("house"));
	SendJson(Body);
	TArray<FString> Asked;
	for (const auto& Pair : Body->Values)
	{
		Asked.Add(FString(Pair.Key));
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: net: asked about my house: %s"), *FString::Join(Asked, TEXT(", ")));
}

/** One house somebody lives in, from `welcome` or a `lived` message; `gone` takes it off the list. */
void UEarthWalkNet::ReadLived(const TSharedPtr<FJsonObject>& Row)
{
	double X = 0.0, Y = 0.0, Id = 0.0;
	if (!Row.IsValid() || !Row->TryGetNumberField(TEXT("x"), X) || !Row->TryGetNumberField(TEXT("y"), Y) || !Row->TryGetNumberField(TEXT("id"), Id))
	{
		return;
	}
	const FString Key = HouseKey(static_cast<int64>(X), static_cast<int64>(Y), static_cast<int64>(Id));
	bool bGone = false;
	Row->TryGetBoolField(TEXT("gone"), bGone);
	if (bGone)
	{
		Homes.Remove(Key);
	}
	else
	{
		FEarthLived Lived;
		Lived.X = static_cast<int32>(X);
		Lived.Y = static_cast<int32>(Y);
		Lived.Id = static_cast<int64>(Id);
		Row->TryGetNumberField(TEXT("lat"), Lived.Lat);
		Row->TryGetNumberField(TEXT("lon"), Lived.Lon);
		Row->TryGetNumberField(TEXT("yaw"), Lived.Yaw);
		Row->TryGetStringField(TEXT("name"), Lived.Name);
		double Rev = 0.0;
		Row->TryGetNumberField(TEXT("rev"), Rev);
		Lived.Rev = static_cast<int64>(Rev);
		Row->TryGetNumberField(TEXT("lift"), Lived.Lift);
		const TArray<TSharedPtr<FJsonValue>>* Young = nullptr;
		if (Row->TryGetArrayField(TEXT("garden"), Young))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Young)
			{
				const TSharedPtr<FJsonObject>* Animal = nullptr;
				FString Sp;
				double Size = 1.0;
				if (Value.IsValid() && Value->TryGetObject(Animal) && (*Animal)->TryGetStringField(TEXT("sp"), Sp))
				{
					(*Animal)->TryGetNumberField(TEXT("size"), Size);
					Lived.Garden.Emplace(Sp, Size);
				}
			}
		}
		Homes.Add(Key, Lived);
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: net: house %s is lived in by %s, change %lld"), *Key, *Lived.Name, Lived.Rev);
	}
	OnLived.Broadcast(Key, bGone);
}

void UEarthWalkNet::SendChat(const FString& Text)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server, so nobody can hear you yet."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("chat"));
	Message->SetStringField(TEXT("text"), Text);
	SendJson(Message);
}

void UEarthWalkNet::SendHome()
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("home"));
	SendJson(Message);
}

void UEarthWalkNet::SendHome(double Lat, double Lon, const FString& Name)
{
	if (!bJoined)
	{
		OnNotice.Broadcast(TEXT("Not connected to the meetup server."));
		return;
	}
	const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
	Message->SetStringField(TEXT("t"), TEXT("home"));
	Message->SetNumberField(TEXT("lat"), Lat);
	Message->SetNumberField(TEXT("lon"), Lon);
	Message->SetStringField(TEXT("name"), Name);
	SendJson(Message);
}

void UEarthWalkNet::RequestPeople()
{
	if (bJoined)
	{
		const TSharedRef<FJsonObject> Message = MakeShared<FJsonObject>();
		Message->SetStringField(TEXT("t"), TEXT("people"));
		SendJson(Message);
	}
}

// ---------------------------------------------------------------- sign-in link

void UEarthWalkNet::BeginLogin()
{
	StopLogin();
	// A short code the browser page and this game share; letters that are hard to misread.
	static const TCHAR Alphabet[] = TEXT("ABCDEFGHJKLMNPQRSTUVWXYZ23456789");
	for (int32 i = 0; i < 8; i++)
	{
		LinkCode.AppendChar(Alphabet[FMath::RandRange(0, 31)]);
	}
	FString Url = FString::Printf(TEXT("%s/link?code=%s"), *FEarthWalkConfig::ServerUrl(), *LinkCode);
	if (const FString Shared = FEarthWalkConfig::SharedCode(); !Shared.IsEmpty())
	{
		// The access code lets a new Google account sign up; known accounts do not need it.
		Url += TEXT("&access=") + FGenericPlatformHttp::UrlEncode(Shared);
	}
	FPlatformProcess::LaunchURL(*Url, nullptr, nullptr);
	OnNotice.Broadcast(FString::Printf(TEXT("Your browser is opening the sign-in page. If it does not, open %s yourself. Waiting for you to sign in..."), *Url));
	LinkStartedAt = FPlatformTime::Seconds();

	TWeakObjectPtr<UEarthWalkNet> WeakThis(this);
	LinkHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakThis](float)
	{
		if (UEarthWalkNet* Self = WeakThis.Get())
		{
			Self->PollLink();
		}
		return false;
	}), LinkPollSeconds);
}

void UEarthWalkNet::StopLogin()
{
	FTSTicker::GetCoreTicker().RemoveTicker(LinkHandle);
	LinkHandle.Reset();
	LinkCode.Empty();
}

void UEarthWalkNet::PollLink()
{
	LinkHandle.Reset();
	if (LinkCode.IsEmpty())
	{
		return;
	}
	if (FPlatformTime::Seconds() - LinkStartedAt > LinkTimeoutSeconds)
	{
		StopLogin();
		OnNotice.Broadcast(TEXT("The sign-in took too long. Type /login to try again."));
		return;
	}
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("%s/v1/link/%s"), *FEarthWalkConfig::ServerUrl(), *LinkCode));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(15.f);
	TWeakObjectPtr<UEarthWalkNet> WeakThis(this);
	const FString Code = LinkCode;
	Request->OnProcessRequestComplete().BindLambda([WeakThis, Code](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		UEarthWalkNet* Self = WeakThis.Get();
		if (!Self || Self->LinkCode != Code)
		{
			return; // cancelled, or a newer /login replaced this one
		}
		FString Token, Name;
		TSharedPtr<FJsonObject> Json;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200)
		{
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
			if (FJsonSerializer::Deserialize(Reader, Json) && Json.IsValid())
			{
				Json->TryGetStringField(TEXT("token"), Token);
				Json->TryGetStringField(TEXT("name"), Name);
			}
		}
		if (Token.IsEmpty())
		{
			// Not yet: ask again shortly.
			Self->LinkHandle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([WeakThis](float)
			{
				if (UEarthWalkNet* Again = WeakThis.Get())
				{
					Again->PollLink();
				}
				return false;
			}), LinkPollSeconds);
			return;
		}
		Self->StopLogin();
		FEarthWalkConfig::Save(TEXT("Token"), Token);
		// The account's name and animal take over from whatever this device had set.
		FEarthWalkConfig::Save(TEXT("Name"), FString());
		FEarthWalkConfig::Save(TEXT("Avatar"), FString());
		Self->bFirstWelcome = true; // so the next welcome can take the player home
		Self->OnNotice.Broadcast(FString::Printf(TEXT("Signed in as %s. This device will remember you."), *Name));
		Self->Connect();
	});
	Request->ProcessRequest();
}

void UEarthWalkNet::Logout()
{
	StopLogin();
	const FString Token = FEarthWalkConfig::PlayerToken();
	if (Token.IsEmpty())
	{
		OnNotice.Broadcast(TEXT("You are not signed in."));
		return;
	}
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FEarthWalkConfig::ServerUrl() + TEXT("/auth/logout"));
	Request->SetVerb(TEXT("POST"));
	Request->SetTimeout(15.f);
	Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Token);
	Request->ProcessRequest(); // best effort; the token is forgotten here either way
	FEarthWalkConfig::Save(TEXT("Token"), FString());
	FEarthWalkConfig::Save(TEXT("HomeLat"), FString());
	FEarthWalkConfig::Save(TEXT("HomeLon"), FString());
	FEarthWalkConfig::Save(TEXT("HomeName"), FString());
	bSignedIn = false;
	bHomePending = false;
	Home = FEarthHome();
	People.Reset();
	OnNotice.Broadcast(TEXT("Signed out. You are a guest again; /login signs you back in."));
	Connect();
}

bool UEarthWalkNet::TakePendingHome(double& OutLat, double& OutLon, FString& OutName)
{
	if (!bHomePending || !Home.bSet)
	{
		return false;
	}
	bHomePending = false;
	OutLat = Home.Lat;
	OutLon = Home.Lon;
	OutName = Home.Name;
	return true;
}

// ---------------------------------------------------------------- incoming messages

static void ReadPeerPosition(const TSharedPtr<FJsonObject>& From, FEarthPeer& Peer)
{
	double Lat = 0.0, Lon = 0.0;
	if (From->TryGetNumberField(TEXT("lat"), Lat) && From->TryGetNumberField(TEXT("lon"), Lon))
	{
		Peer.Lat = Lat;
		Peer.Lon = Lon;
		From->TryGetNumberField(TEXT("alt"), Peer.Alt);
		From->TryGetNumberField(TEXT("yaw"), Peer.Yaw);
		Peer.bHasPosition = true;
	}
}

static FEarthHome ReadHome(const TSharedPtr<FJsonObject>& From)
{
	FEarthHome Out;
	if (From.IsValid() && From->TryGetNumberField(TEXT("lat"), Out.Lat) && From->TryGetNumberField(TEXT("lon"), Out.Lon))
	{
		Out.bSet = true;
		From->TryGetStringField(TEXT("name"), Out.Name);
	}
	return Out;
}

namespace
{
	/** An identity is a whole number up to 2^32, which a JSON number holds exactly. */
	bool ReadThing(const FJsonObject& Json, uint32& Out)
	{
		double Value = 0.0;
		if (!Json.TryGetNumberField(TEXT("thing"), Value) || !FMath::IsFinite(Value) || Value < 0.0 || Value > 4294967295.0)
		{
			return false;
		}
		Out = static_cast<uint32>(static_cast<int64>(Value));
		return true;
	}

	FEarthRide ReadRide(const FJsonObject& Json)
	{
		FEarthRide Ride;
		double Seat = 0.0;
		if (ReadThing(Json, Ride.Thing) && Json.TryGetStringField(TEXT("sp"), Ride.Sp))
		{
			Ride.bOn = true;
			Ride.Seat = Json.TryGetNumberField(TEXT("seat"), Seat) ? FMath::Clamp(FMath::RoundToInt32(Seat), 0, 3) : 0;
		}
		return Ride;
	}

	bool ReadLeft(const FJsonObject& Json, FEarthLeft& Out)
	{
		if (!ReadThing(Json, Out.Thing) || !Json.TryGetStringField(TEXT("sp"), Out.Sp)
			|| !Json.TryGetNumberField(TEXT("lat"), Out.Lat) || !Json.TryGetNumberField(TEXT("lon"), Out.Lon) || !Json.TryGetNumberField(TEXT("until"), Out.Until))
		{
			return false;
		}
		Json.TryGetNumberField(TEXT("alt"), Out.Alt);
		Json.TryGetNumberField(TEXT("yaw"), Out.Yaw);
		return true;
	}

	bool ReadLatLon(const TSharedPtr<FJsonValue>& Value, double& Lat, double& Lon)
	{
		const TArray<TSharedPtr<FJsonValue>>* Pair = nullptr;
		return Value.IsValid() && Value->TryGetArray(Pair) && Pair->Num() >= 2 && (*Pair)[0].IsValid() && (*Pair)[1].IsValid()
			&& (*Pair)[0]->TryGetNumber(Lat) && (*Pair)[1]->TryGetNumber(Lon) && FMath::IsFinite(Lat) && FMath::IsFinite(Lon);
	}

	bool ReadOrder(const FJsonObject& Json, FEarthOrder& Out)
	{
		if (!ReadThing(Json, Out.Thing) || !Json.TryGetStringField(TEXT("sp"), Out.Sp) || !Json.TryGetStringField(TEXT("act"), Out.Act))
		{
			return false;
		}
		Json.TryGetStringField(TEXT("by"), Out.By);
		Json.TryGetStringField(TEXT("name"), Out.Name);
		Out.bHasAt = Json.TryGetNumberField(TEXT("lat"), Out.Lat) && Json.TryGetNumberField(TEXT("lon"), Out.Lon);
		Json.TryGetNumberField(TEXT("at"), Out.At);
		Json.TryGetNumberField(TEXT("until"), Out.Until);
		Json.TryGetBoolField(TEXT("more"), Out.bMore);
		Json.TryGetBoolField(TEXT("onward"), Out.bOnward);
		const TArray<TSharedPtr<FJsonValue>>* To = nullptr;
		if (Json.TryGetArrayField(TEXT("to"), To) && To->Num() >= 2 && (*To)[0].IsValid() && (*To)[1].IsValid())
		{
			Out.bHasTo = (*To)[0]->TryGetNumber(Out.ToLat) && (*To)[1]->TryGetNumber(Out.ToLon);
		}
		const TArray<TSharedPtr<FJsonValue>>* Path = nullptr;
		if (Json.TryGetArrayField(TEXT("path"), Path))
		{
			for (const TSharedPtr<FJsonValue>& Point : *Path)
			{
				double Lat = 0.0, Lon = 0.0;
				if (ReadLatLon(Point, Lat, Lon))
				{
					Out.Path.Add(FVector2D(Lat, Lon));
				}
			}
		}
		return true;
	}

	bool ReadTaxi(const FJsonObject& Json, FEarthTaxi& Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* Path = nullptr;
		if (!ReadThing(Json, Out.Thing) || !Json.TryGetArrayField(TEXT("path"), Path))
		{
			return false;
		}
		for (const TSharedPtr<FJsonValue>& Point : *Path)
		{
			double Lat = 0.0, Lon = 0.0;
			if (ReadLatLon(Point, Lat, Lon))
			{
				Out.Path.Add(FVector2D(Lat, Lon));
			}
		}
		Json.TryGetStringField(TEXT("by"), Out.By);
		Json.TryGetStringField(TEXT("name"), Out.Name);
		Json.TryGetStringField(TEXT("dest"), Out.Dest);
		Json.TryGetNumberField(TEXT("at"), Out.At);
		Json.TryGetNumberField(TEXT("until"), Out.Until);
		return Out.Path.Num() > 0;
	}

	bool ReadOwnCar(const FJsonObject& Json, FEarthOwnCar& Out)
	{
		double Paint = 0.0;
		if (!ReadThing(Json, Out.Thing) || !Json.TryGetNumberField(TEXT("lat"), Out.Lat) || !Json.TryGetNumberField(TEXT("lon"), Out.Lon))
		{
			return false;
		}
		Json.TryGetStringField(TEXT("body"), Out.Body);
		Json.TryGetNumberField(TEXT("yaw"), Out.Yaw);
		if (Json.TryGetNumberField(TEXT("paint"), Paint) && Paint >= 0.0 && Paint <= 16777215.0)
		{
			Out.Paint = static_cast<uint32>(Paint);
		}
		return true;
	}

	FEarthPet ReadPet(const FJsonObject& Json)
	{
		FEarthPet Pet;
		Pet.bOn = Json.TryGetStringField(TEXT("sp"), Pet.Sp) && ReadThing(Json, Pet.Thing);
		return Pet;
	}

	/** The race of a welcome or a race message; not on when the field is missing or null. */
	FEarthGame ReadGame(const FJsonObject& Json)
	{
		FEarthGame Game;
		const TSharedPtr<FJsonObject>* Object = nullptr;
		if (!Json.TryGetObjectField(TEXT("play"), Object) || !(*Object)->TryGetStringField(TEXT("kind"), Game.Kind))
		{
			return Game; // none: over and cleared away
		}
		Game.bOn = true;
		(*Object)->TryGetStringField(TEXT("by"), Game.By);
		(*Object)->TryGetStringField(TEXT("byName"), Game.ByName);
		(*Object)->TryGetStringField(TEXT("state"), Game.State);
		(*Object)->TryGetStringField(TEXT("it"), Game.It);
		(*Object)->TryGetNumberField(TEXT("lat"), Game.Lat);
		(*Object)->TryGetNumberField(TEXT("lon"), Game.Lon);
		(*Object)->TryGetNumberField(TEXT("radius"), Game.Radius);
		(*Object)->TryGetNumberField(TEXT("made"), Game.Made);
		(*Object)->TryGetNumberField(TEXT("startAt"), Game.StartAt);
		(*Object)->TryGetNumberField(TEXT("seekAt"), Game.SeekAt);
		(*Object)->TryGetNumberField(TEXT("endAt"), Game.EndAt);
		(*Object)->TryGetNumberField(TEXT("since"), Game.Since);
		double Goal = 0.0;
		(*Object)->TryGetNumberField(TEXT("goal"), Goal);
		Game.Goal = FMath::RoundToInt32(Goal);
		const TArray<TSharedPtr<FJsonValue>>* Penned = nullptr;
		if ((*Object)->TryGetArrayField(TEXT("penned"), Penned))
		{
			Game.Penned = Penned->Num();
		}
		const TArray<TSharedPtr<FJsonValue>>* Players = nullptr;
		if ((*Object)->TryGetArrayField(TEXT("players"), Players))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Players)
			{
				const TSharedPtr<FJsonObject>* Row = nullptr;
				if (Value.IsValid() && Value->TryGetObject(Row))
				{
					FEarthPlayer Player;
					double Found = 0.0;
					(*Row)->TryGetStringField(TEXT("id"), Player.Id);
					(*Row)->TryGetStringField(TEXT("name"), Player.Name);
					(*Row)->TryGetNumberField(TEXT("itMs"), Player.ItMs);
					Player.bFound = (*Row)->TryGetNumberField(TEXT("found"), Found) && Found > 0.0; // when they were found; none while hidden
					Game.Players.Add(Player);
				}
			}
		}
		return Game;
	}

	FEarthRace ReadRace(const FJsonObject& Json)
	{
		FEarthRace Race;
		const TSharedPtr<FJsonObject>* Object = nullptr;
		const TArray<TSharedPtr<FJsonValue>>* Gates = nullptr;
		if (!Json.TryGetObjectField(TEXT("race"), Object) || !(*Object)->TryGetArrayField(TEXT("gates"), Gates))
		{
			return Race;
		}
		for (const TSharedPtr<FJsonValue>& Gate : *Gates)
		{
			double Lat = 0.0, Lon = 0.0;
			if (ReadLatLon(Gate, Lat, Lon))
			{
				Race.Gates.Add(FVector2D(Lat, Lon));
			}
		}
		Race.bOn = Race.Gates.Num() > 1;
		(*Object)->TryGetStringField(TEXT("by"), Race.By);
		(*Object)->TryGetStringField(TEXT("byName"), Race.ByName);
		(*Object)->TryGetStringField(TEXT("state"), Race.State);
		(*Object)->TryGetNumberField(TEXT("metres"), Race.Metres);
		(*Object)->TryGetNumberField(TEXT("startAt"), Race.StartAt);
		(*Object)->TryGetNumberField(TEXT("made"), Race.Made);
		(*Object)->TryGetStringField(TEXT("kind"), Race.Kind);
		(*Object)->TryGetStringArrayField(TEXT("obstacles"), Race.Obstacles);
		const TArray<TSharedPtr<FJsonValue>>* Runners = nullptr;
		if ((*Object)->TryGetArrayField(TEXT("runners"), Runners))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Runners)
			{
				const TSharedPtr<FJsonObject>* Row = nullptr;
				if (Value.IsValid() && Value->TryGetObject(Row))
				{
					FEarthRunner Runner;
					double Gate = 0.0;
					(*Row)->TryGetStringField(TEXT("id"), Runner.Id);
					(*Row)->TryGetStringField(TEXT("name"), Runner.Name);
					(*Row)->TryGetNumberField(TEXT("gate"), Gate);
					Runner.Gate = FMath::RoundToInt32(Gate);
					Runner.bFinished = (*Row)->TryGetNumberField(TEXT("time"), Runner.TimeMs);
					Race.Runners.Add(Runner);
				}
			}
		}
		return Race;
	}

	bool StaysInForce(const FEarthOrder& Order)
	{
		return Order.Act == TEXT("follow") || Order.Act == TEXT("come") || Order.Act == TEXT("stay");
	}
}

void UEarthWalkNet::HandleMessage(const FString& Message)
{
	TSharedPtr<FJsonObject> Json;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Message);
	if (!FJsonSerializer::Deserialize(Reader, Json) || !Json.IsValid())
	{
		return;
	}
	FString Type;
	if (!Json->TryGetStringField(TEXT("t"), Type))
	{
		return;
	}

	if (Type == TEXT("peers"))
	{
		const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
		if (Json->TryGetArrayField(TEXT("p"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TArray<TSharedPtr<FJsonValue>>* Cells = nullptr;
				if (Row.IsValid() && Row->TryGetArray(Cells) && Cells->Num() >= 5)
				{
					if (FEarthPeer* Peer = Peers.Find((*Cells)[0]->AsString()))
					{
						Peer->Lat = (*Cells)[1]->AsNumber();
						Peer->Lon = (*Cells)[2]->AsNumber();
						Peer->Alt = (*Cells)[3]->AsNumber();
						Peer->Yaw = (*Cells)[4]->AsNumber();
						Peer->bHasPosition = true;
					}
				}
			}
		}
	}
	else if (Type == TEXT("time"))
	{
		// The answer to AskTime: the server's clock, and our own stopwatch reading sent back.
		double Sent = 0.0, ServerMs = 0.0;
		if (Json->TryGetNumberField(TEXT("c"), Sent) && Json->TryGetNumberField(TEXT("now"), ServerMs))
		{
			const double Trip = FPlatformTime::Seconds() * 1000.0 - Sent;
			if (Trip >= 0.0 && Trip < ClockTripMs)
			{
				ClockTripMs = Trip;
				ClockOffsetMs = ServerMs + Trip / 2.0 - LocalNow() * 1000.0;
				bClockSet = true;
				UE_LOG(LogTemp, Log, TEXT("EarthWalk: shared clock: the server is %.0f ms from this PC's clock (round trip %.0f ms)"), ClockOffsetMs, Trip);
			}
		}
	}
	else if (Type == TEXT("chat"))
	{
		OnChat.Broadcast(Json->GetStringField(TEXT("name")), Json->GetStringField(TEXT("text")));
	}
	else if (Type == TEXT("ride"))
	{
		// Someone hopped on something, or (no thing) off. For me it is the go-ahead.
		const FString Id = Json->GetStringField(TEXT("id"));
		const FEarthRide Ride = ReadRide(*Json);
		if (Ride.bOn)
		{
			Left.Remove(Ride.Thing);
		}
		if (Id == MyId)
		{
			MyRide = Ride;
			OnRide.Broadcast(MyRide);
		}
		else if (FEarthPeer* Peer = Peers.Find(Id))
		{
			Peer->Ride = Ride;
		}
	}
	else if (Type == TEXT("left"))
	{
		FEarthLeft Thing;
		if (ReadLeft(*Json, Thing))
		{
			Left.Add(Thing.Thing, Thing);
		}
	}
	else if (Type == TEXT("order"))
	{
		FEarthOrder Order;
		if (ReadOrder(*Json, Order))
		{
			if (StaysInForce(Order))
			{
				Orders.Add(Order.Thing, Order);
			}
			else if (Order.Act == TEXT("home"))
			{
				Orders.Remove(Order.Thing);
			}
			OnOrder.Broadcast(Order);
		}
	}
	else if (Type == TEXT("say"))
	{
		FEarthSay Said;
		if (ReadThing(*Json, Said.Thing) && Json->TryGetStringField(TEXT("sp"), Said.Sp) && Json->TryGetStringField(TEXT("name"), Said.Name)
			&& Json->TryGetStringField(TEXT("text"), Said.Text))
		{
			Json->TryGetStringField(TEXT("by"), Said.By);
			Json->TryGetStringField(TEXT("q"), Said.Asked);
			Said.bHasAt = Json->TryGetNumberField(TEXT("lat"), Said.Lat) && Json->TryGetNumberField(TEXT("lon"), Said.Lon);
			OnSay.Broadcast(Said);
		}
	}
	else if (Type == TEXT("race"))
	{
		// The race in this room, whole, each time anything about it changes; none when it is over and cleared away.
		Race = ReadRace(*Json);
		OnRace.Broadcast();
	}
	else if (Type == TEXT("play"))
	{
		// The game of tag, of hide and seek or the round-up in this room, whole, each time anything about it changes.
		Game = ReadGame(*Json);
		OnPlay.Broadcast();
	}
	else if (Type == TEXT("pet"))
	{
		// A member's companion has come along, or gone home.
		const FString Id = Json->GetStringField(TEXT("id"));
		const FEarthPet Pet = ReadPet(*Json);
		if (Id == MyId)
		{
			MyPet = Pet;
		}
		else if (FEarthPeer* Peer = Peers.Find(Id))
		{
			Peer->Pet = Pet;
		}
	}
	else if (Type == TEXT("car"))
	{
		// A member's own car stands here, with this body and paint; or has gone.
		const FString Id = Json->GetStringField(TEXT("id"));
		FEarthOwnCar Car;
		if (ReadOwnCar(*Json, Car))
		{
			Cars.Add(Id, Car);
		}
		else
		{
			Cars.Remove(Id);
		}
	}
	else if (Type == TEXT("hat"))
	{
		// Somebody has put a hat on, or taken it off.
		const FString Id = Json->GetStringField(TEXT("id"));
		FString Hat;
		Json->TryGetStringField(TEXT("hat"), Hat);
		if (Id == MyId)
		{
			MyHat = Hat;
		}
		else if (FEarthPeer* Peer = Peers.Find(Id))
		{
			Peer->Hat = Hat;
		}
		OnHat.Broadcast(Id, Hat);
	}
	else if (Type == TEXT("taxi"))
	{
		// A taxi is on its way to whoever called it, or one nobody boarded has driven off.
		bool bGone = false;
		FEarthTaxi Taxi;
		if (Json->TryGetBoolField(TEXT("gone"), bGone) && bGone)
		{
			if (ReadThing(*Json, Taxi.Thing))
			{
				Taxis.RemoveAndCopyValue(Taxi.Thing, Taxi);
				OnTaxi.Broadcast(Taxi, true);
			}
		}
		else if (ReadTaxi(*Json, Taxi))
		{
			Taxis.Add(Taxi.Thing, Taxi);
			OnTaxi.Broadcast(Taxi, false);
		}
	}
	else if (Type == TEXT("guide"))
	{
		// The guide's answer, to me alone (docs/PROTOCOL.md, "The guide").
		FEarthGuideAnswer Answer;
		Json->TryGetStringField(TEXT("q"), Answer.Q);
		Json->TryGetStringField(TEXT("text"), Answer.Text);
		Json->TryGetBoolField(TEXT("ai"), Answer.bAi);
		const TSharedPtr<FJsonObject>* Place = nullptr;
		if (Json->TryGetObjectField(TEXT("place"), Place) && (*Place)->TryGetNumberField(TEXT("lat"), Answer.Lat) && (*Place)->TryGetNumberField(TEXT("lon"), Answer.Lon))
		{
			Answer.bPlace = true;
			(*Place)->TryGetStringField(TEXT("name"), Answer.PlaceName);
		}
		const TArray<TSharedPtr<FJsonValue>>* Buttons = nullptr;
		if (Json->TryGetArrayField(TEXT("go"), Buttons))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Buttons)
			{
				const TSharedPtr<FJsonObject>* Button = nullptr;
				FEarthGuideGo Go;
				if (Value.IsValid() && Value->TryGetObject(Button) && (*Button)->TryGetStringField(TEXT("act"), Go.Act) && (*Button)->TryGetStringField(TEXT("label"), Go.Label))
				{
					(*Button)->TryGetStringField(TEXT("show"), Go.Show);
					Answer.Go.Add(Go);
				}
			}
		}
		const TArray<TSharedPtr<FJsonValue>>* More = nullptr;
		if (Json->TryGetArrayField(TEXT("ask"), More))
		{
			for (const TSharedPtr<FJsonValue>& Value : *More)
			{
				FString Question;
				if (Value.IsValid() && Value->TryGetString(Question) && !Question.IsEmpty())
				{
					Answer.Ask.Add(Question);
				}
			}
		}
		OnGuide.Broadcast(Answer);
	}
	else if (Type == TEXT("journal"))
	{
		const TSharedPtr<FJsonObject>* Journal = nullptr;
		OnJournal.Broadcast(Json->TryGetObjectField(TEXT("journal"), Journal) ? *Journal : TSharedPtr<FJsonObject>());
	}
	else if (Type == TEXT("lesson"))
	{
		FEarthLesson Lesson;
		Json->TryGetStringField(TEXT("trick"), Lesson.Trick);
		Json->TryGetStringField(TEXT("name"), Lesson.Name);
		Json->TryGetNumberField(TEXT("slack"), Lesson.Slack);
		Json->TryGetBoolField(TEXT("done"), Lesson.bDone);
		Json->TryGetBoolField(TEXT("passed"), Lesson.bPassed);
		double Hits = 0.0, Of = 0.0;
		Json->TryGetNumberField(TEXT("hits"), Hits);
		Json->TryGetNumberField(TEXT("of"), Of);
		Lesson.Hits = FMath::RoundToInt32(Hits);
		Lesson.Of = FMath::RoundToInt32(Of);
		const TArray<TSharedPtr<FJsonValue>>* Beats = nullptr;
		if (Json->TryGetArrayField(TEXT("beats"), Beats))
		{
			for (const TSharedPtr<FJsonValue>& Beat : *Beats)
			{
				Lesson.Beats.Add(Beat->AsNumber());
			}
		}
		OnLesson.Broadcast(Lesson);
	}
	else if (Type == TEXT("trick"))
	{
		// Somebody's companion does a trick.
		FString Id, Sp, Trick;
		uint32 Thing = 0;
		if (Json->TryGetStringField(TEXT("id"), Id) && Json->TryGetStringField(TEXT("trick"), Trick) && ReadThing(*Json, Thing))
		{
			Json->TryGetStringField(TEXT("sp"), Sp);
			OnTrick.Broadcast(Id, Thing, Sp, Trick);
		}
	}
	else if (Type == TEXT("lived"))
	{
		ReadLived(Json);
	}
	else if (Type == TEXT("house"))
	{
		// My own house: got, furnished differently, or (null) given up.
		const TSharedPtr<FJsonObject>* House = nullptr;
		MyHouse = Json->TryGetObjectField(TEXT("house"), House) ? *House : TSharedPtr<FJsonObject>();
		OnHouse.Broadcast(false);
	}
	else if (Type == TEXT("menu"))
	{
		// What the shop or café beside me sells.
		FEarthMenu Menu;
		Json->TryGetStringField(TEXT("use"), Menu.Use);
		Json->TryGetStringField(TEXT("country"), Menu.Country);
		const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
		if (Json->TryGetArrayField(TEXT("items"), Items))
		{
			for (const TSharedPtr<FJsonValue>& Value : *Items)
			{
				const TSharedPtr<FJsonObject>* Row = nullptr;
				FEarthFood Food;
				if (!Value.IsValid() || !Value->TryGetObject(Row) || !(*Row)->TryGetStringField(TEXT("id"), Food.Id) || !(*Row)->TryGetStringField(TEXT("name"), Food.Name))
				{
					continue;
				}
				(*Row)->TryGetStringArrayField(TEXT("groups"), Food.Groups);
				double Price = 0.0;
				(*Row)->TryGetNumberField(TEXT("price"), Price);
				Food.Price = FMath::RoundToInt32(Price);
				Menu.Items.Add(MoveTemp(Food));
			}
		}
		OnMenu.Broadcast(Menu);
	}
	else if (Type == TEXT("pep"))
	{
		bool bOn = false;
		Json->TryGetBoolField(TEXT("on"), bOn);
		OnPep.Broadcast(bOn);
	}
	else if (Type == TEXT("progress"))
	{
		FEarthProgress News;
		const TSharedPtr<FJsonObject>* Level = nullptr;
		if (Json->TryGetObjectField(TEXT("level"), Level) && ReadLevel(**Level, News.Level))
		{
			Json->TryGetNumberField(TEXT("gained"), News.Gained);
			Json->TryGetStringField(TEXT("why"), News.Why);
			const TSharedPtr<FJsonObject>* Up = nullptr;
			if (Json->TryGetObjectField(TEXT("up"), Up))
			{
				News.bUp = true;
				double Number = 0.0;
				News.UpN = (*Up)->TryGetNumberField(TEXT("n"), Number) ? FMath::RoundToInt32(Number) : News.Level.N;
				(*Up)->TryGetStringField(TEXT("title"), News.UpTitle);
				News.UpCoins = (*Up)->TryGetNumberField(TEXT("coins"), Number) ? FMath::RoundToInt32(Number) : 0;
				News.UpRiddles = (*Up)->TryGetNumberField(TEXT("riddles"), Number) ? FMath::RoundToInt32(Number) : 0;
			}
			OnProgress.Broadcast(News);
		}
	}
	else if (Type == TEXT("stamp"))
	{
		FString Kind, Title, Text;
		Json->TryGetStringField(TEXT("kind"), Kind);
		Json->TryGetStringField(TEXT("text"), Text);
		if (Json->TryGetStringField(TEXT("title"), Title))
		{
			OnStamp.Broadcast(Kind, Title, Text);
		}
		// "Treasure found!" says where the finder stood, for a chest to be shown there.
		const TSharedPtr<FJsonObject>* At = nullptr;
		double Lat = 0.0, Lon = 0.0;
		if (Json->TryGetObjectField(TEXT("at"), At) && (*At)->TryGetNumberField(TEXT("lat"), Lat) && (*At)->TryGetNumberField(TEXT("lon"), Lon))
		{
			OnTreasure.Broadcast(Lat, Lon);
		}
	}
	else if (Type == TEXT("join"))
	{
		FEarthPeer Peer;
		Peer.Name = Json->GetStringField(TEXT("name"));
		Json->TryGetStringField(TEXT("avatar"), Peer.Avatar);
		Peers.Add(Json->GetStringField(TEXT("id")), Peer);
		OnNotice.Broadcast(FString::Printf(TEXT("%s joined. Type /join %s to go to them."), *Peer.Name, *Peer.Name));
	}
	else if (Type == TEXT("leave"))
	{
		Cars.Remove(Json->GetStringField(TEXT("id"))); // their car goes with them
		FEarthPeer Gone;
		if (Peers.RemoveAndCopyValue(Json->GetStringField(TEXT("id")), Gone))
		{
			OnNotice.Broadcast(FString::Printf(TEXT("%s left."), *Gone.Name));
		}
	}
	else if (Type == TEXT("people"))
	{
		People.Reset();
		const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
		if (Json->TryGetArrayField(TEXT("p"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				if (!Row.IsValid() || !Row->TryGetObject(Object))
				{
					continue;
				}
				FEarthPerson Person;
				(*Object)->TryGetStringField(TEXT("id"), Person.Id);
				(*Object)->TryGetStringField(TEXT("name"), Person.Name);
				(*Object)->TryGetStringField(TEXT("avatar"), Person.Avatar);
				(*Object)->TryGetBoolField(TEXT("online"), Person.bOnline);
				(*Object)->TryGetStringField(TEXT("room"), Person.Room);
				(*Object)->TryGetStringField(TEXT("place"), Person.Place);
				(*Object)->TryGetStringField(TEXT("home"), Person.Home);
				double LastSeen = 0.0;
				if ((*Object)->TryGetNumberField(TEXT("lastSeen"), LastSeen))
				{
					Person.LastSeen = static_cast<int64>(LastSeen);
				}
				Person.bHasPosition = (*Object)->TryGetNumberField(TEXT("lat"), Person.Lat) && (*Object)->TryGetNumberField(TEXT("lon"), Person.Lon);
				People.Add(MoveTemp(Person));
			}
		}
	}
	else if (Type == TEXT("home"))
	{
		Home = ReadHome(Json);
		if (Home.bSet)
		{
			FEarthWalkConfig::Save(TEXT("HomeLat"), FString::Printf(TEXT("%.6f"), Home.Lat));
			FEarthWalkConfig::Save(TEXT("HomeLon"), FString::Printf(TEXT("%.6f"), Home.Lon));
			FEarthWalkConfig::Save(TEXT("HomeName"), Home.Name);
			OnNotice.Broadcast(FString::Printf(TEXT("Home set to %s. You will start there next time."), *Home.Name));
		}
	}
	else if (Type == TEXT("welcome"))
	{
		MyId = Json->GetStringField(TEXT("id"));
		MyName = Json->GetStringField(TEXT("name"));
		MyHat.Reset(); // the server says which hat I have on right after this, if any
		MyPet = FEarthPet(); // and which companion is with me
		RoomName = Json->GetStringField(TEXT("room"));
		bJoined = true;
		Json->TryGetBoolField(TEXT("signedIn"), bSignedIn);
		// A first estimate of the shared clock; SyncClock then measures it properly.
		double ServerMs = 0.0;
		if (Json->TryGetNumberField(TEXT("now"), ServerMs))
		{
			ClockOffsetMs = ServerMs - LocalNow() * 1000.0;
			ClockTripMs = TNumericLimits<double>::Max();
			bClockSet = true;
			ClockStartedAt = FPlatformTime::Seconds();
			SyncClock();
		}
		Peers.Reset();

		// Houses are in the world, not in a room: everybody is told of every one that is lived in, and of their own.
		Homes.Reset();
		const TArray<TSharedPtr<FJsonValue>>* LivedRows = nullptr;
		if (Json->TryGetArrayField(TEXT("lived"), LivedRows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *LivedRows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				if (Row.IsValid() && Row->TryGetObject(Object))
				{
					ReadLived(*Object);
				}
			}
		}
		const TSharedPtr<FJsonObject>* House = nullptr;
		MyHouse = Json->TryGetObjectField(TEXT("house"), House) ? *House : TSharedPtr<FJsonObject>();
		OnHouse.Broadcast(true);

		Home = FEarthHome();
		if (bSignedIn)
		{
			const TSharedPtr<FJsonObject>* HomeObject = nullptr;
			if (Json->TryGetObjectField(TEXT("home"), HomeObject))
			{
				Home = ReadHome(*HomeObject);
			}
			if (Home.bSet)
			{
				FEarthWalkConfig::Save(TEXT("HomeLat"), FString::Printf(TEXT("%.6f"), Home.Lat));
				FEarthWalkConfig::Save(TEXT("HomeLon"), FString::Printf(TEXT("%.6f"), Home.Lon));
				FEarthWalkConfig::Save(TEXT("HomeName"), Home.Name);
			}
			// Keep the figure on this device in step with the account's animal.
			FString Avatar;
			if (Json->TryGetStringField(TEXT("avatar"), Avatar) && !Avatar.IsEmpty() && Avatar != FEarthWalkConfig::Avatar())
			{
				FEarthWalkConfig::Save(TEXT("Avatar"), Avatar);
			}
			if (bFirstWelcome && Home.bSet)
			{
				bHomePending = true;
			}
		}
		bFirstWelcome = false;

		TArray<FString> Names;
		const TArray<TSharedPtr<FJsonValue>>* Rows = nullptr;
		if (Json->TryGetArrayField(TEXT("peers"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				if (Row.IsValid() && Row->TryGetObject(Object))
				{
					FEarthPeer Peer;
					Peer.Name = (*Object)->GetStringField(TEXT("name"));
					(*Object)->TryGetStringField(TEXT("avatar"), Peer.Avatar);
					ReadPeerPosition(*Object, Peer);
					const TSharedPtr<FJsonObject>* Riding = nullptr;
					if ((*Object)->TryGetObjectField(TEXT("ride"), Riding))
					{
						Peer.Ride = ReadRide(**Riding);
					}
					(*Object)->TryGetStringField(TEXT("hat"), Peer.Hat);
					const TSharedPtr<FJsonObject>* Companion = nullptr;
					if ((*Object)->TryGetObjectField(TEXT("pet"), Companion))
					{
						Peer.Pet = ReadPet(**Companion);
					}
					Names.Add(Peer.Name);
					Peers.Add((*Object)->GetStringField(TEXT("id")), Peer);
				}
			}
		}
		OnNotice.Broadcast(FString::Printf(TEXT("You are %s%s in room \"%s\". %s"), *MyName, bSignedIn ? TEXT(" (signed in)") : TEXT(""), *RoomName,
			Names.Num() ? *FString::Printf(TEXT("Here now: %s."), *FString::Join(Names, TEXT(", "))) : TEXT("Nobody else is here yet.")));

		// What is standing where a rider left it, and what has been told to follow, come or stay.
		Left.Reset();
		Orders.Reset();
		if (Json->TryGetArrayField(TEXT("left"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				FEarthLeft Thing;
				if (Row.IsValid() && Row->TryGetObject(Object) && ReadLeft(**Object, Thing))
				{
					Left.Add(Thing.Thing, Thing);
				}
			}
		}
		if (Json->TryGetArrayField(TEXT("orders"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				FEarthOrder Order;
				if (Row.IsValid() && Row->TryGetObject(Object) && ReadOrder(**Object, Order) && StaysInForce(Order))
				{
					Orders.Add(Order.Thing, Order);
				}
			}
		}
		Race = ReadRace(*Json);
		OnRace.Broadcast();
		Game = ReadGame(*Json);
		OnPlay.Broadcast();
		Cars.Reset();
		if (Json->TryGetArrayField(TEXT("cars"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				FEarthOwnCar Car;
				FString Owner;
				if (Row.IsValid() && Row->TryGetObject(Object) && (*Object)->TryGetStringField(TEXT("id"), Owner) && ReadOwnCar(**Object, Car))
				{
					Cars.Add(Owner, Car);
				}
			}
		}
		Taxis.Reset();
		if (Json->TryGetArrayField(TEXT("taxis"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				FEarthTaxi Taxi;
				if (Row.IsValid() && Row->TryGetObject(Object) && ReadTaxi(**Object, Taxi))
				{
					Taxis.Add(Taxi.Thing, Taxi);
				}
			}
		}
		if (MyRide.bOn)
		{
			MyRide = FEarthRide(); // a new connection starts on foot
			OnRide.Broadcast(MyRide);
		}

		if (Json->TryGetArrayField(TEXT("history"), Rows))
		{
			for (const TSharedPtr<FJsonValue>& Row : *Rows)
			{
				const TSharedPtr<FJsonObject>* Object = nullptr;
				if (Row.IsValid() && Row->TryGetObject(Object))
				{
					OnChat.Broadcast((*Object)->GetStringField(TEXT("name")), (*Object)->GetStringField(TEXT("text")));
				}
			}
		}
		OnWelcome.Broadcast();
	}
	else if (Type == TEXT("error"))
	{
		FString Code;
		Json->TryGetStringField(TEXT("code"), Code);
		if (Code == TEXT("denied") || Code == TEXT("full"))
		{
			bDenied = true; // do not hammer the server with retries
		}
		if (Code == TEXT("taken"))
		{
			OnRideFail.Broadcast();
		}
		OnNotice.Broadcast(FString::Printf(TEXT("Server: %s"), *Json->GetStringField(TEXT("text"))));
		OnError.Broadcast(Code, Json->GetStringField(TEXT("text")));
	}
}
