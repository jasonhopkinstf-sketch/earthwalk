#pragma once

#include "CoreMinimal.h"
#include "Containers/Ticker.h"
#include "Subsystems/GameInstanceSubsystem.h"
#include "EarthWalkNet.generated.h"

class IWebSocket;

/** What someone is riding: the thing's identity, what kind it is, and which seat (0 steers). */
struct FEarthRide
{
	bool bOn = false;
	uint32 Thing = 0;
	FString Sp;
	int32 Seat = 0;
};

/** A thing standing where its driver got off, until the server's clock reaches Until (milliseconds). */
struct FEarthLeft
{
	uint32 Thing = 0;
	FString Sp;
	double Lat = 0.0;
	double Lon = 0.0;
	double Alt = 0.0;
	double Yaw = 0.0;
	double Until = 0.0;
};

/** Something a thing was told to do, and agreed to (docs/PROTOCOL.md, "Doing as asked"). */
struct FEarthOrder
{
	uint32 Thing = 0;
	FString Sp;
	FString Act; // follow, come, stay, home, trick, noise, goto
	FString By;  // the member who asked
	bool bHasAt = false;
	double Lat = 0.0;
	double Lon = 0.0;
	bool bHasTo = false;
	double ToLat = 0.0;
	double ToLon = 0.0;
	double At = 0.0;    // when it was told, server clock in milliseconds: tells one order from the next
	double Until = 0.0; // when it lapses
	FString Name;       // goto: the place
	TArray<FVector2D> Path; // goto: the way there by road, as latitude and longitude
};

/** A taxi on its way to whoever called it, or waiting for them (docs/PROTOCOL.md, "Taxis"). */
struct FEarthTaxi
{
	uint32 Thing = 0;
	FString By;   // the member who called it
	FString Name; // the taxi's own name
	FString Dest; // where it was asked to go
	TArray<FVector2D> Path; // the road it comes along, as latitude and longitude, ending beside the caller
	double At = 0.0;    // when it set off, server clock in milliseconds
	double Until = 0.0; // when it gives up waiting
};

/** A player's own car, standing where it was called to or left (docs/PROTOCOL.md, "The garage"). */
struct FEarthOwnCar
{
	uint32 Thing = 0;
	FString Body;     // "car" or "van"
	uint32 Paint = 0; // 0xRRGGBB
	double Lat = 0.0;
	double Lon = 0.0;
	double Yaw = 0.0;
};

/** A thing spoke: to me, or to somebody near me. */
struct FEarthSay
{
	uint32 Thing = 0;
	FString Sp;
	FString Name;
	FString Text;
	FString By;
	FString Asked; // what it was asked; empty for a hello
	bool bHasAt = false;
	double Lat = 0.0;
	double Lon = 0.0;
};

/** Someone else in the same room. */
struct FEarthPeer
{
	FEarthRide Ride;
	FString Hat; // the hat they are wearing; empty for none
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
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthRide, const FEarthRide& /*Mine*/);
DECLARE_MULTICAST_DELEGATE(FOnEarthRideFail);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthSay, const FEarthSay& /*Said*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthOrder, const FEarthOrder& /*Order*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthHat, const FString& /*MemberId*/, const FString& /*Hat, or empty*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthTreasure, double /*Lat*/, double /*Lon*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthTaxi, const FEarthTaxi& /*Taxi*/, bool /*bGone*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthJournal, const TSharedPtr<class FJsonObject>& /*Journal, or null*/);
DECLARE_MULTICAST_DELEGATE_ThreeParams(FOnEarthStamp, const FString& /*Kind*/, const FString& /*Title*/, const FString& /*Text*/);

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
	const FString& GetMyId() const { return MyId; }
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

	/** Asks to hop on something; the go-ahead comes back through OnRide. */
	void SendRide(uint32 Thing, const FString& Sp);
	/** Says I have hopped off. */
	void SendDismount();
	/** Says hello to a thing (no text), or says something to it; its answer comes through OnSay. Lat/Lon are where I see it. */
	void SendTalk(uint32 Thing, const FString& Sp, const FString& Text = FString(), bool bHasAt = false, double Lat = 0.0, double Lon = 0.0);
	/** Asks for my own journal; it comes through OnJournal. */
	void RequestJournal();
	/** Buys a hat with my coins and puts it on; puts on one I own; or (empty) takes my hat off. The room hears through OnHat. */
	void SendHatBuy(const FString& Id);
	void SendHatWear(const FString& Id);
	const FString& GetMyHat() const { return MyHat; }
	/** Sets out on an expedition from the passport ("hunt" is the treasure hunt of where I stand), or gives one up. My journal comes back. */
	void SendExpedition(const FString& Id, bool bStart);
	/** Gives up a favour I was asked; my journal comes back without it. */
	void SendFavourDrop(const FString& Id);
	/**
	 * The garage: "call" brings my car to stand beside me, "away" sends it off, and "paint" or "body" with
	 * an id chooses one (paying for it in coins the first time). The room hears of the car with a car message.
	 */
	void SendGarage(const FString& What, const FString& Id = FString());
	/** Everyone's own car that is standing in the room, by its owner's member id. */
	const TMap<FString, FEarthOwnCar>& GetCars() const { return Cars; }
	/** Calls a taxi to take me to a place; it is announced through OnTaxi. */
	void SendTaxi(const FString& Place);
	/** Taxis on their way or waiting, by identity. The caller removes the ones whose time is up. */
	TMap<uint32, FEarthTaxi>& GetTaxis() { return Taxis; }

	/** What I am riding, once the server has said so. Each peer has a Ride of its own. */
	const FEarthRide& GetMyRide() const { return MyRide; }
	/** Things left standing where a rider got off, by identity. The caller removes the ones whose time is up. */
	TMap<uint32, FEarthLeft>& GetLeft() { return Left; }
	/** The follow, come and stay orders in force, by the thing's identity. The caller removes the ones whose time is up. */
	TMap<uint32, FEarthOrder>& GetOrders() { return Orders; }

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
	FOnEarthRide OnRide;
	FOnEarthRideFail OnRideFail;
	FOnEarthSay OnSay;
	FOnEarthOrder OnOrder;
	FOnEarthTaxi OnTaxi;
	FOnEarthHat OnHat;
	/** A treasure was found by me, at this place: a chest is shown there. */
	FOnEarthTreasure OnTreasure;
	FOnEarthJournal OnJournal;
	FOnEarthStamp OnStamp;

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
	FEarthRide MyRide;
	FString MyHat;
	TMap<uint32, FEarthLeft> Left;
	TMap<uint32, FEarthOrder> Orders;
	TMap<uint32, FEarthTaxi> Taxis;
	TMap<FString, FEarthOwnCar> Cars;
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
