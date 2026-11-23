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
	bool bMore = false;   // goto: a long drive, and Path is one leg of it: it ends on the way to the place, not at it
	bool bOnward = false; // goto: the next leg of the drive already under way
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

/** A button under an answer of the guide: "take" (my ride carries me), "taxi", "jump" (go there now) or "show" (a Show me place, whose id is Show). */
struct FEarthGuideGo
{
	FString Act;
	FString Label;
	FString Show;
};

/** What the guide answered (docs/PROTOCOL.md, "The guide"). */
struct FEarthGuideAnswer
{
	FString Q;    // the question this answers, as the server read it
	FString Text; // what it says
	bool bAi = false;
	bool bPlace = false; // the answer is about one place
	FString PlaceName;
	double Lat = 0.0;
	double Lon = 0.0;
	TArray<FEarthGuideGo> Go; // the buttons that start the trip, in the order to show them
	TArray<FString> Ask;      // questions to ask next, with one click
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

/** The animal that keeps a player company: its kind and its own identity (docs/PROTOCOL.md, "Riddles and companions"). */
struct FEarthPet
{
	bool bOn = false;
	FString Sp;
	uint32 Thing = 0;
};

/** Somebody in a race: how many gates they have passed, and their time once they have finished. */
struct FEarthRunner
{
	FString Id;
	FString Name;
	int32 Gate = 0;
	bool bFinished = false;
	double TimeMs = 0.0;
};

/** The race set up in this room, if any (docs/PROTOCOL.md, "Races"). */
struct FEarthRace
{
	bool bOn = false;
	FString By;     // the member who set it up
	FString ByName;
	FString State;  // open, go, over
	TArray<FVector2D> Gates; // latitude and longitude of each, in turn
	double Metres = 0.0;
	double StartAt = 0.0; // server clock, milliseconds
	double Made = 0.0;
	TArray<FEarthRunner> Runners;
	FString Kind;              // "agility" for an agility course; empty for a race by road
	TArray<FString> Obstacles; // an agility course: what stands at each gate (start, jump, hoop, weave, tunnel, table, finish)
};

/** Somebody in a game of tag, of hide and seek, or in a round-up. */
struct FEarthPlayer
{
	FString Id;
	FString Name;
	double ItMs = 0.0;   // tag: how long they have been it; a round-up: how many animals they have brought in
	bool bFound = false; // hide and seek
};

/** The game of tag, of hide and seek, or the round-up in this room, if any (docs/PROTOCOL.md, "Tag, and hide and seek"). */
struct FEarthGame
{
	bool bOn = false;
	FString Kind;  // tag, hide, herd
	FString By;    // the member who set it up
	FString ByName;
	FString State; // open, go, over
	FString It;    // who is it, or seeking
	double Lat = 0.0; // the middle of the field, or of the pen
	double Lon = 0.0;
	double Radius = 0.0;
	double Made = 0.0;    // times on the server's clock, in milliseconds
	double StartAt = 0.0;
	double SeekAt = 0.0;
	double EndAt = 0.0;
	double Since = 0.0;   // tag: since when the one who is it has been
	int32 Goal = 0;       // a round-up: how many animals are wanted
	int32 Penned = 0;     // and how many are in
	TArray<FEarthPlayer> Players;
};

/** A house somebody lives in (docs/PROTOCOL.md, "A house of your own"): which, where its front door is, whose, and how often it has been changed. */
struct FEarthLived
{
	int32 X = 0; // the chunk it is in, wrapped to the world
	int32 Y = 0;
	int64 Id = 0; // its number there: the id of its door label
	double Lat = 0.0;
	double Lon = 0.0;
	double Yaw = 0.0; // the compass heading that leads out of its door
	FString Name;     // its owner's
	int64 Rev = 0;    // tells one furnishing from the next (a large number): the inside is fetched again when it moves on
	double Lift = 0.0; // a house built from its owner's plan stands this far above the real one (AEarthWorld::HouseLift)
	TArray<TPair<FString, double>> Garden; // the young animals before its door: what each is, and how big it has grown (0.45 to 1)
};

/** A lesson in a trick (docs/PROTOCOL.md, "Tricks"): set with its beats, and marked when the presses have been sent. */
struct FEarthLesson
{
	FString Trick;
	FString Name;         // "Sit up"
	TArray<double> Beats; // milliseconds from when it was set
	double Slack = 0.0;   // how near a beat a press must fall
	bool bDone = false;   // the server's marks, not a lesson to begin
	bool bPassed = false;
	int32 Hits = 0;
	int32 Of = 0;
};

/** Something to eat, as a shop or a café sells it (docs/PROTOCOL.md, "Food and hearts"). */
struct FEarthFood
{
	FString Id;
	FString Name;           // "a plate of sushi"
	TArray<FString> Groups; // which hearts it fills: fruit, veg, grain, protein, dairy
	int32 Price = 0;        // coins
};

/** What is sold where the player stands: at a shop ("shop") or somewhere to eat ("food"). */
struct FEarthMenu
{
	FString Use;
	FString Country; // somewhere to eat begins with this country's dishes
	TArray<FEarthFood> Items;
};

/** Someone else in the same room. */
struct FEarthPeer
{
	FEarthRide Ride;
	FString Hat; // the hat they are wearing; empty for none
	FEarthPet Pet;
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
DECLARE_MULTICAST_DELEGATE(FOnEarthRace);
DECLARE_MULTICAST_DELEGATE(FOnEarthPlay);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthHat, const FString& /*MemberId*/, const FString& /*Hat, or empty*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthTreasure, double /*Lat*/, double /*Lon*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthTaxi, const FEarthTaxi& /*Taxi*/, bool /*bGone*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthGuide, const FEarthGuideAnswer& /*Answer*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthError, const FString& /*Code*/, const FString& /*Text*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthJournal, const TSharedPtr<class FJsonObject>& /*Journal, or null*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthMenu, const FEarthMenu& /*Menu*/);
DECLARE_MULTICAST_DELEGATE_TwoParams(FOnEarthLived, const FString& /*Key: "x/y/id"*/, bool /*bGone*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthHouse, bool /*bFromWelcome: what a new connection says of my house is not news*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthPep, bool /*bAllHeartsFull*/);
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthLesson, const FEarthLesson& /*Lesson*/);
DECLARE_MULTICAST_DELEGATE_FourParams(FOnEarthTrick, const FString& /*MemberId*/, uint32 /*Thing*/, const FString& /*Sp*/, const FString& /*Trick*/);
DECLARE_MULTICAST_DELEGATE_ThreeParams(FOnEarthStamp, const FString& /*Kind*/, const FString& /*Title*/, const FString& /*Text*/);

/** The level a player is on (docs/PROTOCOL.md, "Progress"): the bar is (Points - From) of (Next - From) full. */
struct FEarthLevel
{
	int32 N = 0;
	FString Title;
	double Points = 0.0;
	double From = 0.0;
	double Next = 0.0;
	FString Hint; // what would reach the next level, a whole sentence
};
/** Where the player stands, and what has just earned points: nothing (Gained 0) in the word sent once after the welcome. */
struct FEarthProgress
{
	FEarthLevel Level;
	double Gained = 0.0;
	FString Why;      // a few words for what earned them
	bool bUp = false; // these points reached a new level
	int32 UpN = 0;
	FString UpTitle;
	int32 UpCoins = 0;
	int32 UpRiddles = 0;
};
DECLARE_MULTICAST_DELEGATE_OneParam(FOnEarthProgress, const FEarthProgress& /*News*/);

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

	void SendPosition(double Lat, double Lon, double Alt, double Yaw, bool bFlown = false);
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
	/** The same to somebody inside a shop or an office: with what they do there, and which building it is (its chunk and number). */
	void SendTalkInside(uint32 Thing, const FString& Sp, const FString& Text, const FString& Role, FIntPoint Chunk, int64 Building);
	/** Asks for my own journal; it comes through OnJournal. */
	void RequestJournal();
	/** Buys a hat with my coins and puts it on; puts on one I own; or (empty) takes my hat off. The room hears through OnHat. */
	void SendHatBuy(const FString& Id);
	void SendHatWear(const FString& Id);
	const FString& GetMyHat() const { return MyHat; }
	/** Chooses the companion that follows me, from those I have won; empty sends it home. */
	void SendPet(const FString& Sp);
	const FEarthPet& GetMyPet() const { return MyPet; }
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
	/** A race: "make" one where I stand, "join" the one set up, say "go" (its maker), or "stop" (leave it; its maker ends it). */
	void SendRace(const FString& What);
	/** Sets up an agility course where I stand, for me and my companion (docs/PROTOCOL.md, "Races"). */
	void SendAgility();
	/** Tricks: "learn" begins a lesson in a trick, "do" has my companion do one it knows. */
	void SendTrick(const FString& Verb, const FString& Trick);
	/** My presses for the lesson under way, in milliseconds from when it was set. The marks come through OnLesson. */
	void SendTrickPresses(const TArray<int32>& Presses);
	/** The garden of my house: "adopt" a young animal (Sp), or "feed", "gather" from or "release" the one at a place (Index). */
	void SendGarden(const FString& Verb, const FString& Sp, int32 Index = 0);
	const FEarthRace& GetRace() const { return Race; }
	/** Tag, hide and seek, the round-up: "make" one (Kind: tag, hide or herd) where I stand, "join" the one set up, "go" to start mine, "stop" to leave. */
	void SendPlay(const FString& Verb, const FString& Kind = FString());
	const FEarthGame& GetGame() const { return Game; }
	/** Calls a taxi to take me to a place; it is announced through OnTaxi. With bAt the place's position is known already (from the guide), and the name is not looked up again. */
	void SendTaxi(const FString& Place, bool bAt = false, double Lat = 0.0, double Lon = 0.0);
	/** Asks the guide something in plain words; the answer comes through OnGuide. */
	void SendGuide(const FString& Question);
	/** "Take me there" under an answer of the guide: what I am riding carries me to that place, as when told so itself. */
	void SendGuideTake(const FString& Name, double Lat, double Lon);
	/**
	 * Food and hearts: "eat" one of these from my lunch box, ask for the "menu" of a shop ("shop") or of
	 * somewhere to eat ("food"), "buy" one there (With says which of the two), "cook" a recipe, or
	 * "give" one to the member whose id With is. My journal comes back, and the menu through OnMenu.
	 */
	void SendFood(const FString& Verb, const FString& What, const FString& With = FString());
	/**
	 * A house of my own: Body is one of `claim`, `leave`, `put`, `place` or `plan` as
	 * docs/PROTOCOL.md has them ("A house of your own"); `t` is added here. My house comes back through OnHouse.
	 */
	void SendHouse(const TSharedRef<class FJsonObject>& Body);
	/** Every house somebody lives in, by "x/y/id" (HouseKey). */
	const TMap<FString, FEarthLived>& GetHomes() const { return Homes; }
	/** My own house as the server last told it (with its `decor`), or null when I have none. */
	const TSharedPtr<class FJsonObject>& GetMyHouse() const { return MyHouse; }
	static FString HouseKey(int64 X, int64 Y, int64 Id) { return FString::Printf(TEXT("%lld/%lld/%lld"), ((X % 65536) + 65536) % 65536, Y, Id); }
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
	FOnEarthGuide OnGuide;
	/** Something the server refused, by its code ("slow", "nowhere"...) and in its words. It is a notice too. */
	FOnEarthError OnError;
	FOnEarthHat OnHat;
	/** The room's race has changed in some way: set up, joined, begun, a gate passed, over, cleared away. */
	FOnEarthRace OnRace;
	/** The room's game of tag, hide and seek or its round-up has changed in some way, or is over and cleared away. */
	FOnEarthPlay OnPlay;
	/** A treasure was found by me, at this place: a chest is shown there. */
	FOnEarthTreasure OnTreasure;
	FOnEarthJournal OnJournal;
	FOnEarthStamp OnStamp;
	/** Where I stand on the way to the next level, and what has just earned points (EarthProgress.h). */
	FOnEarthProgress OnProgress;
	/** Reads a `level` object, of a `progress` message or of the journal. False when it is not one. */
	static bool ReadLevel(const class FJsonObject& Json, FEarthLevel& Out);
	/** What the shop or café beside me sells: the answer to SendFood("menu", ...). */
	FOnEarthMenu OnMenu;
	/** All five hearts are full today (or, false, no longer): the player goes a little quicker on foot. */
	FOnEarthPep OnPep;
	/** A lesson has been set, or marked. */
	FOnEarthLesson OnLesson;
	/** Somebody's companion is doing a trick: every game draws it. */
	FOnEarthTrick OnTrick;
	/** A house has been moved into, furnished anew, or left. */
	FOnEarthLived OnLived;
	/** My own house has changed: got, furnished, or given up. */
	FOnEarthHouse OnHouse;

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
	FEarthPet MyPet;
	TMap<uint32, FEarthLeft> Left;
	TMap<uint32, FEarthOrder> Orders;
	TMap<uint32, FEarthTaxi> Taxis;
	TMap<FString, FEarthOwnCar> Cars;
	TMap<FString, FEarthLived> Homes;
	TSharedPtr<class FJsonObject> MyHouse;
	void ReadLived(const TSharedPtr<class FJsonObject>& Row);
	FEarthRace Race;
	FEarthGame Game;
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
