#include "EarthWalkNet.h"

#include "EarthWalkSettings.h"
#include "Dom/JsonObject.h"
#include "IWebSocket.h"
#include "Modules/ModuleManager.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"
#include "WebSocketsModule.h"

void UEarthWalkNet::Deinitialize()
{
	Disconnect();
	Super::Deinitialize();
}

void UEarthWalkNet::Disconnect()
{
	bWantConnection = false;
	bJoined = false;
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
			Hello->SetStringField(TEXT("name"), FEarthWalkConfig::PlayerName());
			Hello->SetStringField(TEXT("room"), FEarthWalkConfig::Room());
			const FString Code = FEarthWalkConfig::AccessCode();
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

void UEarthWalkNet::SendPosition(double Lat, double Lon, double Alt, double Yaw)
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
	SendJson(Message);
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
	else if (Type == TEXT("chat"))
	{
		OnChat.Broadcast(Json->GetStringField(TEXT("name")), Json->GetStringField(TEXT("text")));
	}
	else if (Type == TEXT("join"))
	{
		FEarthPeer Peer;
		Peer.Name = Json->GetStringField(TEXT("name"));
		Peers.Add(Json->GetStringField(TEXT("id")), Peer);
		OnNotice.Broadcast(FString::Printf(TEXT("%s joined. Type /join %s to go to them."), *Peer.Name, *Peer.Name));
	}
	else if (Type == TEXT("leave"))
	{
		FEarthPeer Gone;
		if (Peers.RemoveAndCopyValue(Json->GetStringField(TEXT("id")), Gone))
		{
			OnNotice.Broadcast(FString::Printf(TEXT("%s left."), *Gone.Name));
		}
	}
	else if (Type == TEXT("welcome"))
	{
		MyId = Json->GetStringField(TEXT("id"));
		MyName = Json->GetStringField(TEXT("name"));
		RoomName = Json->GetStringField(TEXT("room"));
		bJoined = true;
		Peers.Reset();

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
					ReadPeerPosition(*Object, Peer);
					Names.Add(Peer.Name);
					Peers.Add((*Object)->GetStringField(TEXT("id")), Peer);
				}
			}
		}
		OnNotice.Broadcast(FString::Printf(TEXT("You are %s in room \"%s\". %s"), *MyName, *RoomName,
			Names.Num() ? *FString::Printf(TEXT("Here now: %s."), *FString::Join(Names, TEXT(", "))) : TEXT("Nobody else is here yet.")));

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
	}
	else if (Type == TEXT("error"))
	{
		FString Code;
		Json->TryGetStringField(TEXT("code"), Code);
		if (Code == TEXT("denied") || Code == TEXT("full"))
		{
			bDenied = true; // do not hammer the server with retries
		}
		OnNotice.Broadcast(FString::Printf(TEXT("Server: %s"), *Json->GetStringField(TEXT("text"))));
	}
}
