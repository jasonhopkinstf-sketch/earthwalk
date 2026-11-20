#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "EarthWalkNet.generated.h"

class IWebSocket;

/** Someone else in the same room. */
struct FEarthPeer
{
	FString Name;
	double Lat = 0.0;
	double Lon = 0.0;
	double Alt = 0.0; // metres above sea level, at the feet
	double Yaw = 0.0; // compass heading in degrees
	bool bHasPosition = false;
};

DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthChat, const FString& /*Name*/, const FString& /*Text*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthNotice, const FString& /*Text*/);

/**
 * Connection to the world server's meetup room: who is here, where they are, and chat.
 * The message format is described in docs/PROTOCOL.md.
 */
UCLASS()
class UEarthWalkNet : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Deinitialize() override;

	/** (Re)connects using the current server, name, room and access code. */
	void Connect();
	void Disconnect();

	bool IsConnected() const { return bJoined; }
	const FString& GetMyName() const { return MyName; }
	const FString& GetRoom() const { return RoomName; }
	const TMap<FString, FEarthPeer>& GetPeers() const { return Peers; }

	void SendPosition(double Lat, double Lon, double Alt, double Yaw);
	void SendChat(const FString& Text);

	FOnEarthChat OnChat;
	FOnEarthNotice OnNotice;

private:
	void HandleMessage(const FString& Message);
	void HandleDropped(const FString& Why);
	void SendJson(const TSharedRef<class FJsonObject>& Object);

	TSharedPtr<IWebSocket> Socket;
	TMap<FString, FEarthPeer> Peers;
	FString MyId;
	FString MyName;
	FString RoomName;
	bool bJoined = false;
	bool bWantConnection = false;
	bool bDenied = false;
	FTSTicker::FDelegateHandle RetryHandle;
};
