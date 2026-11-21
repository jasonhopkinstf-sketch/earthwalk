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
	FString Avatar; // which animal they chose
	double Lat = 0.0;
	double Lon = 0.0;
	double Alt = 0.0; // metres above sea level, at the feet
	double Yaw = 0.0; // compass heading in degrees
	bool bHasPosition = false;
};

/** Someone with an account on this server, online or not (the people list). */
struct FEarthPerson
{
	FString Id;
	FString Name;
	FString Avatar;
	bool bOnline = false;
	FString Room;  // where they are (online) or were last (offline)
	FString Place; // "Montmartre, Paris", when the server has named it
	double Lat = 0.0;
	double Lon = 0.0;
	bool bHasPosition = false; // only while online
	int64 LastSeen = 0;        // milliseconds since the epoch
	FString Home;              // the name of their home, if set
};

/** The signed-in player's home. */
struct FEarthHome
{
	bool bSet = false;
	double Lat = 0.0;
	double Lon = 0.0;
	FString Name;
};

DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthChat, const FString& /*Name*/, const FString& /*Text*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthNotice, const FString& /*Text*/);
DECLARE_MULTICAST_DELEGATE(FOnEarthWelcome);

/**
 * Connection to the world server's meetup room: who is here, where they are, and chat.
 * Also the sign-in link (/login) and the signed-in player's home and people list.
 * The message format is described in docs/PROTOCOL.md.
 */
UCLASS()
class UEarthWalkNet : public UGameInstanceSubsystem
{
	GENERATED_BODY()

public:
	virtual void Deinitialize() override;

	/** (Re)connects using the current server, name, room and access code or player token. */
	void Connect();
	void Disconnect();

	bool IsConnected() const { return bJoined; }

	/**
	 * The shared clock, in seconds since 1970: the server's time, as near as we can tell. Everyone in
	 * the world agrees on it to within a few hundredths of a second, which is what keeps the animals,
	 * cars and trains in step between games. Before the server has answered it is this PC's own clock.
	 */
	double Now() const { return LocalNow() + ClockOffsetMs / 1000.0; }
	/** This PC's clock in seconds since 1970, running smoothly (it never jumps while the game runs). */
	static double LocalNow();
	/** True once the server has told us the time. */
	bool HasSharedClock() const { return bClockSet; }
	const FString& GetMyName() const { return MyName; }
	const FString& GetRoom() const { return RoomName; }
	const TMap<FString, FEarthPeer>& GetPeers() const { return Peers; }

	/** True once the server has welcomed us as a signed-in account (not a guest). */
	bool IsSignedIn() const { return bSignedIn; }
	const FEarthHome& GetHome() const { return Home; }
	const TArray<FEarthPerson>& GetPeople() const { return People; }

	void SendPosition(double Lat, double Lon, double Alt, double Yaw);
	void SendChat(const FString& Text);
	/** Sets my home to where I am standing (the server names the place). */
	void SendHome();
	/** Sets my home to a place. */
	void SendHome(double Lat, double Lon, const FString& Name);
	void RequestPeople();

	/**
	 * Sign in with Google: opens the system browser at the server's link page and polls the
	 * server until it hands over a player token, which is saved for later launches.
	 */
	void BeginLogin();
	bool IsLoggingIn() const { return !LinkCode.IsEmpty(); }
	/** Forgets the saved token (and tells the server to), then reconnects as a guest. */
	void Logout();

	/**
	 * After the first welcome of a launch, the account's home if it has one. Returns true once,
	 * so the player can be taken home when the game did not already start there.
	 */
	bool TakePendingHome(double& OutLat, double& OutLon, FString& OutName);

	FOnEarthChat OnChat;
	FOnEarthNotice OnNotice;
	FOnEarthWelcome OnWelcome;

private:
	void HandleMessage(const FString& Message);
	void HandleDropped(const FString& Why);
	void SendJson(const TSharedRef<class FJsonObject>& Object);
	void PollLink();
	void StopLogin();
	void SyncClock();
	void StopClock();
	void AskTime();

	TSharedPtr<IWebSocket> Socket;
	TMap<FString, FEarthPeer> Peers;
	TArray<FEarthPerson> People;
	FEarthHome Home;
	FString MyId;
	FString MyName;
	FString RoomName;
	bool bJoined = false;
	bool bSignedIn = false;
	bool bWantConnection = false;
	bool bDenied = false;
	bool bFirstWelcome = true;
	bool bHomePending = false;
	FTSTicker::FDelegateHandle RetryHandle;

	// Server time minus this PC's time, in milliseconds, and the round trip of the measurement behind it.
	double ClockOffsetMs = 0.0;
	double ClockTripMs = TNumericLimits<double>::Max();
	bool bClockSet = false;
	int32 ClockAsks = 0;
	double ClockStartedAt = 0.0;
	FTSTicker::FDelegateHandle ClockHandle;

	FString LinkCode;
	double LinkStartedAt = 0.0;
	FTSTicker::FDelegateHandle LinkHandle;
};
