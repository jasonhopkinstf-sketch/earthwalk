#include "EarthCompany.h"

#include "EarthLife.h"
#include "EarthLifeMotion.h"
#include "EarthLifeRigs.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkCharacter.h"
#include "EarthWorld.h"
#include "Engine/GameInstance.h"
#include "GameFramework/PlayerController.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

#include <cmath>

namespace
{
	// ---- riding.js
	const FEarthMount MountTable[] = {
		{ TEXT("horse"), 10.0, 1.55, TEXT("horse"), 0.0, false },
		{ TEXT("cow"), 4.0, 1.3, TEXT("cow"), 0.0, false },
		{ TEXT("sheep"), 4.5, 0.92, TEXT("sheep"), 0.0, false },
		{ TEXT("camel"), 5.5, 2.05, TEXT("camel"), 0.0, false },
		{ TEXT("llama"), 5.0, 1.2, TEXT("llama"), 0.0, false },
		{ TEXT("kangaroo"), 9.0, 1.0, TEXT("kangaroo"), 0.0, false },
		{ TEXT("deer"), 9.0, 1.05, TEXT("deer"), 0.0, false },
		{ TEXT("tractor"), 5.0, 1.35, TEXT("tractor"), 4.0, false },
		{ TEXT("car"), 13.0, 0.95, TEXT("car"), 3.5, false }, // up on the roof, where the view is not all bonnet
		{ TEXT("taxi"), 13.0, 0.95, TEXT("taxi"), 4.0, false }, // a browser player can call one (/taxi); here it can be shared and talked to
		{ TEXT("boat"), 2.5, 0.3, TEXT("rowing boat"), 4.0, true },
		{ TEXT("sailboat"), 5.0, 0.75, TEXT("sailing boat"), 6.0, true },
		{ TEXT("train"), 0.0, 3.5, TEXT("train"), 8.0, false },
	};
	constexpr double ReachM = 3.0;

	// ---- talk.js
	struct FCalled
	{
		const TCHAR* Sp;
		const TCHAR* Name;
		double BubbleAt; // how high above the ground its speech bubble floats
		double Reach;    // how near you must be to talk to it
	};
	constexpr double TalkReachM = 5.5;
	const FCalled CalledTable[] = {
		{ TEXT("cow"), TEXT("cow"), 2.2, TalkReachM }, { TEXT("sheep"), TEXT("sheep"), 1.5, TalkReachM }, { TEXT("horse"), TEXT("horse"), 2.8, TalkReachM },
		{ TEXT("chicken"), TEXT("hen"), 1.5, TalkReachM }, { TEXT("duck"), TEXT("duck"), 1.5, TalkReachM }, { TEXT("pigeon"), TEXT("pigeon"), 1.5, TalkReachM },
		{ TEXT("bird"), TEXT("bird"), 1.5, TalkReachM }, { TEXT("cat"), TEXT("cat"), 1.5, TalkReachM }, { TEXT("dog"), TEXT("dog"), 1.5, TalkReachM },
		{ TEXT("rabbit"), TEXT("rabbit"), 1.5, TalkReachM }, { TEXT("deer"), TEXT("deer"), 2.4, TalkReachM }, { TEXT("squirrel"), TEXT("squirrel"), 1.5, TalkReachM },
		{ TEXT("kangaroo"), TEXT("kangaroo"), 2.2, TalkReachM }, { TEXT("llama"), TEXT("llama"), 2.7, TalkReachM }, { TEXT("camel"), TEXT("camel"), 3.2, TalkReachM },
		{ TEXT("penguin"), TEXT("penguin"), 1.5, TalkReachM }, { TEXT("tractor"), TEXT("tractor"), 3.1, 6.0 }, { TEXT("boat"), TEXT("rowing boat"), 1.5, TalkReachM },
		{ TEXT("sailboat"), TEXT("sailing boat"), 4.2, 7.0 }, { TEXT("car"), TEXT("car"), 2.3, 5.0 }, { TEXT("taxi"), TEXT("taxi"), 2.5, 5.0 }, { TEXT("train"), TEXT("train"), 4.8, 9.0 },
		{ TEXT("tree"), TEXT("tree"), 4.5, 4.0 }, { TEXT("house"), TEXT("house"), 3.4, 7.0 },
	};
	const FCalled* CalledRow(const FString& Sp)
	{
		for (const FCalled& Row : CalledTable)
		{
			if (Sp == Row.Sp)
			{
				return &Row;
			}
		}
		return nullptr;
	}
	constexpr double WalkedOffM = 16.0;
	constexpr double BubbleSeconds = 8.0;
	constexpr uint32 SaltTree = 0x54524545;
	constexpr uint32 SaltHouse = 0x484f5553;

	// ---- orders.js
	/** How fast a thing walks when told to come or follow, by kind; the rest amble. */
	double PaceOf(const FString& Sp)
	{
		static const TMap<FString, double> Pace = {
			{ TEXT("horse"), 7.0 }, { TEXT("deer"), 7.0 }, { TEXT("kangaroo"), 7.0 }, { TEXT("dog"), 6.0 }, { TEXT("cat"), 4.5 }, { TEXT("rabbit"), 5.0 },
			{ TEXT("cow"), 3.0 }, { TEXT("sheep"), 3.5 }, { TEXT("camel"), 4.0 }, { TEXT("llama"), 4.0 }, { TEXT("chicken"), 3.0 }, { TEXT("duck"), 2.5 },
			{ TEXT("pigeon"), 3.0 }, { TEXT("squirrel"), 5.0 }, { TEXT("penguin"), 2.0 },
		};
		const double* Found = Pace.Find(Sp);
		return Found ? *Found : 3.0;
	}
	/** A follower stops this far short of whoever it follows, and gives up the chase for a jump beyond LostM. */
	constexpr double HeelM = 2.4;
	constexpr double LostM = 120.0;
	constexpr double TrickS = 1.7;
	/** Straight across country is for short trips; anything longer is one jump. */
	constexpr double CrossCountryM = 1500.0;
	constexpr double ArrivedM = 6.0;
	/** Roads are laid a little above the terrain in this game, so a car drawn on the terrain is lifted to match. */
	constexpr double CarLiftM = 0.18;

	/** Metres (x east, y up, z south from the world's origin) in engine units. */
	FVector SceneToEngine(double X, double Y, double Z) { return FVector(-Z * 100.0, X * 100.0, Y * 100.0); }
}

const FEarthMount* EarthMounts::Find(const FString& Sp)
{
	for (const FEarthMount& Mount : MountTable)
	{
		if (Sp == Mount.Sp)
		{
			return &Mount;
		}
	}
	return nullptr;
}

const TCHAR* EarthMounts::Called(const FString& Sp)
{
	const FCalled* Row = CalledRow(Sp);
	return Row ? Row->Name : nullptr;
}

uint32 EarthMounts::FixedThing(bool bHouse, double TileX, double TileY)
{
	// Math.round, as the browser does it: halves go up.
	const uint32 A = static_cast<uint32>(static_cast<int64>(std::floor(TileX * 8192.0 + 0.5)));
	const uint32 B = static_cast<uint32>(static_cast<int64>(std::floor(TileY * 8192.0 + 0.5)));
	const uint32 Thing = EarthLife::Hash32(EarthLife::Hash32(A, B), bHouse ? SaltHouse : SaltTree);
	return Thing ? Thing : 1;
}

void UEarthCompany::Setup(AEarthWorld* InWorld)
{
	World = InWorld;
	Net = InWorld && InWorld->GetGameInstance() ? InWorld->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (UEarthWalkNet* Room = Net.Get())
	{
		Room->OnRide.AddUObject(this, &UEarthCompany::OnRide);
		Room->OnRideFail.AddUObject(this, &UEarthCompany::OnRideFail);
		Room->OnSay.AddUObject(this, &UEarthCompany::OnSay);
		Room->OnOrder.AddUObject(this, &UEarthCompany::OnOrder);
	}
}

void UEarthCompany::Notice(const FString& Text) const
{
	if (UEarthWalkNet* Room = Net.Get())
	{
		Room->OnNotice.Broadcast(Text);
	}
}

bool UEarthCompany::PlayerAt(double& OutX, double& OutZ) const
{
	const AEarthWalkCharacter* Me = Player.Get();
	if (!Me)
	{
		return false;
	}
	const FVector Here = Me->GetActorLocation();
	OutX = Here.Y / 100.0;
	OutZ = -Here.X / 100.0;
	return true;
}

void UEarthCompany::GeoToScene(double Lat, double Lon, double& OutX, double& OutZ) const
{
	const FVector At = World.IsValid() ? World->GeoToWorld(Lat, Lon, 0.0) : FVector::ZeroVector;
	OutX = At.Y / 100.0;
	OutZ = -At.X / 100.0;
}

bool UEarthCompany::GroundFor(const FString& Sp, double X, double Z, double& OutY) const
{
	if (!World.IsValid() || !World->TerrainHeightAt(X, Z, OutY))
	{
		return false;
	}
	if (Sp == TEXT("car") || Sp == TEXT("taxi"))
	{
		OutY += CarLiftM;
	}
	return true;
}

// ------------------------------------------------------------------------------------------------
// Riding
// ------------------------------------------------------------------------------------------------

void UEarthCompany::KeyRide()
{
	if (Mine.bOn)
	{
		Off();
		return;
	}
	UEarthWalkNet* Room = Net.Get();
	if (bWanted || !bNear || !Room || !Room->IsConnected())
	{
		return;
	}
	Wanted = Near;
	bWanted = true;
	WantedAt = FPlatformTime::Seconds();
	Room->SendRide(Near.Thing, Near.Sp);
}

void UEarthCompany::OnRideFail()
{
	bWanted = false;
}

/** The server's word on what I am riding: the go-ahead to hop on, or that I am off. */
void UEarthCompany::OnRide(const FEarthRide& Ride)
{
	if (!Ride.bOn)
	{
		if (Mine.bOn)
		{
			Land(); // the driver got off, so the passengers do too
		}
		return;
	}
	const FEarthMount* Mount = EarthMounts::Find(Ride.Sp);
	AEarthWalkCharacter* Me = Player.Get();
	if (!Mount || !Me)
	{
		return;
	}
	const bool bFrom = bWanted && Wanted.Thing == Ride.Thing;
	const FEarthThing From = Wanted;
	bWanted = false;
	Mine = Ride;
	MineMount = Mount;
	MineK = bFrom ? From.K : 0;
	Lost = 0.0;
	Me->SetFlying(false);
	const bool bTrain = Ride.Sp == TEXT("train");
	if (bTrain || Ride.Seat > 0)
	{
		Me->SetCarried(true); // the train, or the friend who is steering, moves me
	}
	else
	{
		Me->SetMount(Mount);
		if (bFrom)
		{
			// Onto its back, where it stands, facing the way it faces.
			double Ground = 0.0;
			const FVector Here = Me->FeetLocation();
			const bool bGround = World.IsValid() && World->TerrainHeightAt(From.X, From.Z, Ground);
			Me->PlaceFeetAt(SceneToEngine(From.X, bGround ? Ground + 0.3 : Here.Z / 100.0, From.Z));
			if (APlayerController* PC = Cast<APlayerController>(Me->GetController()))
			{
				FRotator Look = PC->GetControlRotation();
				Look.Yaw = (-From.Yaw * 180.0) / UE_DOUBLE_PI;
				PC->SetControlRotation(Look);
			}
		}
	}
	Notice(Ride.Seat > 0 && !bTrain
		? FString::Printf(TEXT("You are riding along on the %s. Press E to hop off."), Mount->Name)
		: FString::Printf(TEXT("You are on the %s. Press E to hop off."), Mount->Name));
}

/** Hop off, and tell everyone. */
void UEarthCompany::Off()
{
	if (!Mine.bOn)
	{
		return;
	}
	if (UEarthWalkNet* Room = Net.Get())
	{
		Room->SendDismount();
	}
	Land();
}

void UEarthCompany::Land()
{
	const double Side = Mine.Sp == TEXT("train") ? 3.5 : 1.6; // step down to the right
	Mine = FEarthRide();
	MineMount = nullptr;
	AEarthWalkCharacter* Me = Player.Get();
	if (!Me)
	{
		return;
	}
	const FVector Feet = Me->FeetLocation();
	Me->SetMount(nullptr);
	Me->SetCarried(false);
	const APlayerController* PC = Cast<APlayerController>(Me->GetController());
	const double Yaw = PC ? PC->GetControlRotation().Yaw : Me->GetActorRotation().Yaw;
	Me->PlaceFeetAt(Feet + FRotationMatrix(FRotator(0.0, Yaw, 0.0)).GetUnitAxis(EAxis::Y) * Side * 100.0 + FVector(0.0, 0.0, 20.0));
}

void UEarthCompany::Ridden(const FString& Key, uint32 Thing, const FString& Sp, double X, double Z, double Y, double Yaw, double Dt)
{
	FGait& Gait = Gaits.FindOrAdd(Key);
	if (Gait.Thing != Thing)
	{
		Gait.Thing = Thing;
		Gait.X = X;
		Gait.Z = Z;
		Gait.D = 0.0;
	}
	const double Step = std::hypot(X - Gait.X, Z - Gait.Z);
	if (Step < 5.0)
	{
		Gait.D += Step;
	}
	Gait.X = X;
	Gait.Z = Z;
	Hidden.Add(Thing);
	FEarthThing Mount;
	Mount.Key = Key;
	Mount.Thing = Thing;
	Mount.Sp = Sp;
	Mount.X = X;
	Mount.Y = Y;
	Mount.Z = Z;
	Mount.Yaw = Yaw;
	Mount.Gait = Gait.D;
	Mount.bMoving = Dt > 0.0 && Step / Dt > 0.2;
	Mount.bOutOfPlace = true;
	Mounts.Add(Mount);
}

void UEarthCompany::RidingFrame(double Dt, double T)
{
	AEarthWalkCharacter* Me = Player.Get();
	AEarthWorld* Earth = World.Get();
	UEarthWalkNet* Room = Net.Get();
	AEarthLife* Life = Earth ? Earth->GetLife() : nullptr;
	if (!Me || !Earth || !Room || !Life)
	{
		return;
	}
	if (Mine.bOn && Me->IsWaitingForGround())
	{
		Off(); // travelled somewhere else
	}
	if (bWanted && FPlatformTime::Seconds() - WantedAt > 3.0)
	{
		bWanted = false;
	}

	// ---- being carried: by a train, or by the friend who is steering
	if (Mine.bOn && Mine.Sp == TEXT("train"))
	{
		FEarthThing At;
		if (Life->CarriageAt(Earth, Mine.Thing, MineK, T, At))
		{
			Me->PlaceFeetAt(SceneToEngine(At.X, At.Y + MineMount->Seat, At.Z));
		}
		else
		{
			Off(); // the train has gone where this game cannot follow
		}
	}
	else if (Mine.bOn && Mine.Seat > 0)
	{
		const AEarthWalkAvatar* Driver = nullptr;
		for (const TPair<FString, FEarthPeer>& Pair : Room->GetPeers())
		{
			if (Pair.Value.Ride.bOn && Pair.Value.Ride.Thing == Mine.Thing && Pair.Value.Ride.Seat == 0)
			{
				Driver = Earth->FindAvatar(Pair.Key);
			}
		}
		if (Driver)
		{
			Lost = 0.0;
			Me->PlaceFeetAt(Driver->GetActorLocation() - Driver->GetActorForwardVector() * 70.0 * Mine.Seat); // sit behind them
		}
		else if ((Lost += Dt) > 3.0)
		{
			Off();
		}
	}

	// ---- everything being ridden, and everything left standing where its rider got off
	Hidden.Reset();
	Mounts.Reset();
	if (Mine.bOn && Mine.Seat == 0 && Mine.Sp != TEXT("train"))
	{
		// My own mount stands on whatever I stand on: the road, a bridge, the field.
		const FVector Feet = Me->FeetLocation();
		const APlayerController* PC = Cast<APlayerController>(Me->GetController());
		const double Yaw = PC ? PC->GetControlRotation().Yaw : Me->GetActorRotation().Yaw;
		Ridden(TEXT("me"), Mine.Thing, Mine.Sp, Feet.Y / 100.0, -Feet.X / 100.0, Feet.Z / 100.0, (-Yaw * UE_DOUBLE_PI) / 180.0, Dt);
	}
	for (const TPair<FString, FEarthPeer>& Pair : Room->GetPeers())
	{
		const FEarthRide& Ride = Pair.Value.Ride;
		const FEarthMount* Mount = Ride.bOn ? EarthMounts::Find(Ride.Sp) : nullptr;
		if (!Mount || Ride.Seat != 0 || Ride.Sp == TEXT("train"))
		{
			continue;
		}
		if (const AEarthWalkAvatar* Shown = Earth->FindAvatar(Pair.Key))
		{
			const FVector At = Shown->GetActorLocation();
			const double X = At.Y / 100.0, Z = -At.X / 100.0;
			double Y = At.Z / 100.0 - Mount->Seat;
			GroundFor(Ride.Sp, X, Z, Y);
			Ridden(Pair.Key, Ride.Thing, Ride.Sp, X, Z, Y, (-Shown->GetActorRotation().Yaw * UE_DOUBLE_PI) / 180.0, Dt);
		}
		else
		{
			Hidden.Add(Ride.Thing); // ridden off somewhere out of sight
		}
	}
	for (auto It = Room->GetLeft().CreateIterator(); It; ++It)
	{
		const FEarthLeft& Left = It.Value();
		if (Left.Until <= T * 1000.0)
		{
			It.RemoveCurrent(); // time to go home: its timetable has it again
			continue;
		}
		if (Hidden.Contains(Left.Thing) || !EarthMounts::Find(Left.Sp))
		{
			continue;
		}
		double X = 0.0, Z = 0.0, Y = 0.0;
		GeoToScene(Left.Lat, Left.Lon, X, Z);
		Hidden.Add(Left.Thing);
		if (GroundFor(Left.Sp, X, Z, Y))
		{
			FEarthThing Mount;
			Mount.Thing = Left.Thing;
			Mount.Sp = Left.Sp;
			Mount.X = X;
			Mount.Y = Y;
			Mount.Z = Z;
			Mount.Yaw = (-Left.Yaw * UE_DOUBLE_PI) / 180.0;
			Mount.bOutOfPlace = true;
			Mounts.Add(Mount);
		}
	}
	if (Gaits.Num() > 64)
	{
		Gaits.Reset();
	}
	OrdersFrame(Dt, T); // and everything doing as it was told

	// ---- what would E hop on?
	bNear = false;
	double Px = 0.0, Pz = 0.0;
	if (!Mine.bOn && !bWanted && !Me->IsFlying() && !Me->IsWaitingForGround() && PlayerAt(Px, Pz))
	{
		double Best = TNumericLimits<double>::Max();
		const auto Consider = [&](const FEarthThing& Candidate)
		{
			const FEarthMount* Mount = EarthMounts::Find(Candidate.Sp);
			if (!Mount)
			{
				return;
			}
			const double D = std::hypot(Candidate.X - Px, Candidate.Z - Pz);
			const double Reach = Candidate.Reach > 0.0 ? Candidate.Reach : Mount->Reach > 0.0 ? Mount->Reach : ReachM;
			if (D < Reach && D < Best)
			{
				Best = D;
				Near = Candidate;
				bNear = true;
			}
		};
		for (const FEarthThing& Candidate : Life->GetRideable())
		{
			Consider(Candidate);
		}
		for (const FEarthThing& Mount : Mounts)
		{
			Consider(Mount); // one left standing, or a friend's, to ride along on
		}
	}
	RideHint = Mine.bOn && MineMount ? FString::Printf(TEXT("E: hop off the %s"), MineMount->Name)
		: bNear ? FString::Printf(TEXT("E: %s the %s"), Near.Key.IsEmpty() ? TEXT("hop on") : TEXT("ride along on"), EarthMounts::Find(Near.Sp)->Name)
		: FString();
}

// ------------------------------------------------------------------------------------------------
// Talking
// ------------------------------------------------------------------------------------------------

FString UEarthCompany::Title(const FEarthThing& Thing) const
{
	const TCHAR* Kind = EarthMounts::Called(Thing.Sp);
	const FString* Name = Names.Find(Thing.Thing);
	return Name ? FString::Printf(TEXT("%s the %s"), **Name, Kind ? Kind : TEXT("thing")) : FString::Printf(TEXT("the %s"), Kind ? Kind : TEXT("thing"));
}

bool UEarthCompany::KeyTalk()
{
	UEarthWalkNet* Room = Net.Get();
	if (!bTalkNear || !Room || !Room->IsConnected())
	{
		return false;
	}
	To = TalkNear;
	bTalking = true;
	Room->SendTalk(To.Thing, To.Sp);
	return true;
}

void UEarthCompany::Say(const FString& Text)
{
	UEarthWalkNet* Room = Net.Get();
	if (!bTalking || !Room || !World.IsValid())
	{
		return;
	}
	// Where I see the thing, in case it is asked to do something from there.
	double Lat = 0.0, Lon = 0.0, Alt = 0.0;
	World->WorldToGeo(SceneToEngine(To.X, 0.0, To.Z), Lat, Lon, Alt);
	Room->SendTalk(To.Thing, To.Sp, Text, true, Lat, Lon);
}

void UEarthCompany::StopTalking()
{
	bTalking = false;
}

/** Everything near enough to talk to, nearest first: animals, cars and trains, whatever is being ridden, trees and houses. */
void UEarthCompany::Scan()
{
	const AEarthLife* Life = World.IsValid() ? World->GetLife() : nullptr;
	double Px = 0.0, Pz = 0.0;
	bTalkNear = false;
	if (!Life || !PlayerAt(Px, Pz))
	{
		return;
	}
	double BestD = TNumericLimits<double>::Max();
	const auto Consider = [&](const FEarthThing& Candidate, double Handicap)
	{
		const FCalled* Row = CalledRow(Candidate.Sp);
		if (!Row)
		{
			return;
		}
		const double D = std::hypot(Candidate.X - Px, Candidate.Z - Pz);
		if (D < Row->Reach && D + Handicap < BestD)
		{
			BestD = D + Handicap;
			TalkNear = Candidate;
			bTalkNear = true;
		}
		if (bTalking && To.Thing == Candidate.Thing && To.Sp == Candidate.Sp)
		{
			To.X = Candidate.X; // it may have wandered
			To.Z = Candidate.Z;
		}
	};
	for (const FEarthThing& Candidate : Life->GetNearby())
	{
		Consider(Candidate, 0.0);
	}
	for (const FEarthThing& Candidate : Life->GetRideable())
	{
		Consider(Candidate, 0.0);
	}
	for (const FEarthThing& Mount : Mounts)
	{
		Consider(Mount, 0.0);
	}
	// Trees and houses stand still, so they yield to anything livelier that is just as close.
	TArray<FEarthThing> Fixed;
	Life->FixedNear(Px, Pz, Fixed);
	for (const FEarthThing& Candidate : Fixed)
	{
		Consider(Candidate, 1.5);
	}
}

void UEarthCompany::TalkFrame(double Dt)
{
	const AEarthWalkCharacter* Me = Player.Get();
	if (!Me)
	{
		return;
	}
	if ((SinceScan += Dt) > 0.2)
	{
		SinceScan = 0.0;
		if (Me->IsWaitingForGround())
		{
			bTalkNear = false;
		}
		else
		{
			Scan();
		}
		double Px = 0.0, Pz = 0.0;
		PlayerAt(Px, Pz);
		if (bTalking && (Me->IsWaitingForGround() || std::hypot(To.X - Px, To.Z - Pz) > WalkedOffM))
		{
			StopTalking();
		}
		TalkHint = bTalking ? FString::Printf(TEXT("Talking to %s  ·  Enter to speak  ·  Esc to stop"), *Title(To))
			: bTalkNear ? FString::Printf(TEXT("T: talk to %s"), *Title(TalkNear))
			: FString();
	}
	const double Now = FPlatformTime::Seconds();
	Bubbles.RemoveAll([Now](const FBubble& Bubble) { return Now > Bubble.Until; });
}

/** A thing has spoken: to me, or to somebody near me. */
void UEarthCompany::OnSay(const FEarthSay& Said)
{
	const FCalled* Row = CalledRow(Said.Sp);
	AEarthWorld* Earth = World.Get();
	UEarthWalkNet* Room = Net.Get();
	AEarthLife* Life = Earth ? Earth->GetLife() : nullptr;
	if (!Row || !Earth || !Room || !Life)
	{
		return;
	}
	Names.Add(Said.Thing, Said.Name);
	const FEarthPeer* Asker = Room->GetPeers().Find(Said.By);
	const FString Who = Said.By == Room->GetMyId() ? Room->GetMyName() : Asker ? Asker->Name : FString(TEXT("Someone"));
	if (!Said.Asked.IsEmpty())
	{
		OnLine.Broadcast(FString::Printf(TEXT("%s to %s"), *Who, *Said.Name), Said.Asked, false);
	}
	OnLine.Broadcast(FString::Printf(TEXT("%s the %s"), *Said.Name, Row->Name), Said.Text, true);

	// Where is it? Beside me if I can see it; otherwise where the player who spoke to it stands.
	bool bAt = false;
	double X = 0.0, Z = 0.0;
	const auto Place = [&](const FEarthThing& Thing) { X = Thing.X; Z = Thing.Z; bAt = true; };
	if (bTalking && To.Thing == Said.Thing)
	{
		Place(To);
	}
	if (!bAt)
	{
		const TArray<FEarthThing>* const Lists[] = { &Life->GetNearby(), &Life->GetRideable(), &Mounts };
		for (const TArray<FEarthThing>* List : Lists)
		{
			for (const FEarthThing& Thing : *List)
			{
				if (Thing.Thing == Said.Thing && Thing.Sp == Said.Sp)
				{
					Place(Thing);
				}
			}
		}
	}
	if (!bAt && bTalkNear && TalkNear.Thing == Said.Thing)
	{
		Place(TalkNear);
	}
	if (!bAt && Said.bHasAt)
	{
		GeoToScene(Said.Lat, Said.Lon, X, Z);
		bAt = true;
	}
	double Ground = 0.0;
	if (!bAt || !Earth->TerrainHeightAt(X, Z, Ground))
	{
		return;
	}
	Bubbles.RemoveAll([&Said](const FBubble& Bubble) { return Bubble.Thing == Said.Thing; });
	FBubble Bubble;
	Bubble.Thing = Said.Thing;
	Bubble.Name = Said.Name;
	Bubble.Text = Said.Text;
	Bubble.Where = SceneToEngine(X, Ground + Row->BubbleAt, Z);
	Bubble.Until = FPlatformTime::Seconds() + BubbleSeconds + Said.Text.Len() * 0.04;
	Bubbles.Add(Bubble);
	Life->Speak(Earth, Said.Sp, Said.Thing, X, Z); // and its own voice with it, if it has one
}

// ------------------------------------------------------------------------------------------------
// Doing as asked
// ------------------------------------------------------------------------------------------------

/** Where a member of the room is: me, or a friend this game can see. */
bool UEarthCompany::WhereIs(const FString& MemberId, double& OutX, double& OutZ) const
{
	if (Net.IsValid() && MemberId == Net->GetMyId())
	{
		return PlayerAt(OutX, OutZ);
	}
	const AEarthWalkAvatar* Shown = World.IsValid() ? World->FindAvatar(MemberId) : nullptr;
	if (!Shown)
	{
		return false;
	}
	OutX = Shown->GetActorLocation().Y / 100.0;
	OutZ = -Shown->GetActorLocation().X / 100.0;
	return true;
}

/** Where a thing is right now, as this game has it: ordered about, ridden or left, or on its timetable. */
bool UEarthCompany::Find(uint32 Thing, const FString& Sp, FEarthThing& Out) const
{
	if (const FOrderPose* Pose = Poses.Find(Thing))
	{
		Out.Thing = Thing;
		Out.Sp = Sp;
		Out.X = Pose->X;
		Out.Z = Pose->Z;
		Out.Yaw = Pose->Yaw;
		return true;
	}
	for (const FEarthThing& Mount : Mounts)
	{
		if (Mount.Thing == Thing)
		{
			Out = Mount;
			return true;
		}
	}
	const AEarthLife* Life = World.IsValid() ? World->GetLife() : nullptr;
	if (Life)
	{
		const TArray<FEarthThing>* const Lists[] = { &Life->GetNearby(), &Life->GetRideable() };
		for (const TArray<FEarthThing>* List : Lists)
		{
			for (const FEarthThing& Candidate : *List)
			{
				if (Candidate.Thing == Thing && Candidate.Sp == Sp)
				{
					Out = Candidate;
					return true;
				}
			}
		}
	}
	return false;
}

void UEarthCompany::OnOrder(const FEarthOrder& Order)
{
	if (Order.Act == TEXT("trick") || Order.Act == TEXT("noise"))
	{
		FEarthThing At;
		AEarthLife* Life = World.IsValid() ? World->GetLife() : nullptr;
		if (!Life || !Find(Order.Thing, Order.Sp, At))
		{
			return; // too far off to see or hear
		}
		Life->Speak(World.Get(), Order.Sp, Order.Thing, At.X, At.Z);
		if (Order.Act == TEXT("trick") && EarthRigs::Find(Order.Sp))
		{
			FTrick Trick;
			Trick.Sp = Order.Sp;
			Trick.Start = FPlatformTime::Seconds();
			Trick.X = At.X;
			Trick.Z = At.Z;
			Trick.Yaw = At.Yaw;
			Tricks.Add(Order.Thing, Trick);
		}
	}
	else if (Order.Act == TEXT("goto"))
	{
		SetOff(Order);
	}
	else if (Order.Act == TEXT("home"))
	{
		Poses.Remove(Order.Thing);
	}
}

/** The thing I am riding has agreed to take me somewhere. */
void UEarthCompany::SetOff(const FEarthOrder& Order)
{
	AEarthWalkCharacter* Me = Player.Get();
	double Px = 0.0, Pz = 0.0;
	if (!Me || !Mine.bOn || !MineMount || Mine.Thing != Order.Thing || Mine.Seat != 0 || !Order.bHasAt || !PlayerAt(Px, Pz))
	{
		return;
	}
	double Tx = 0.0, Tz = 0.0;
	GeoToScene(Order.Lat, Order.Lon, Tx, Tz);
	const double Far = std::hypot(Tx - Px, Tz - Pz);
	const bool bByRoad = Order.Path.Num() > 1;
	// A car keeps to roads, so without a way by road it jumps; an animal or a tractor can cut across country.
	if (bByRoad || (Far <= CrossCountryM && !MineMount->bAfloat && Mine.Sp != TEXT("car") && Mine.Sp != TEXT("taxi")))
	{
		Trip = FTrip();
		Trip.bOn = true;
		Trip.Thing = Order.Thing;
		Trip.Sp = Order.Sp;
		Trip.Name = Order.Name;
		Trip.EndLat = Order.Lat;
		Trip.EndLon = Order.Lon;
		if (bByRoad)
		{
			for (const FVector2D& Point : Order.Path)
			{
				double X = 0.0, Z = 0.0;
				GeoToScene(Point.X, Point.Y, X, Z);
				Trip.Path.Add(FVector2D(X, Z));
			}
		}
		else
		{
			Trip.Path.Add(FVector2D(Tx, Tz));
		}
		// Join the way at its nearest point: whoever boards a taxi before it has pulled up is not driven back to where they called it.
		for (int32 K = 1; K < Trip.Path.Num(); ++K)
		{
			if (std::hypot(Trip.Path[K].X - Px, Trip.Path[K].Y - Pz) < std::hypot(Trip.Path[Trip.I].X - Px, Trip.Path[Trip.I].Y - Pz))
			{
				Trip.I = K;
			}
		}
		Notice(FString::Printf(TEXT("%s to %s. Steer (WASD) to take over."), bByRoad ? TEXT("Driving") : TEXT("Riding"), *Order.Name));
	}
	else
	{
		// Too far to go by road in this lifetime: one jump, and back on at the other end.
		Notice(FString::Printf(TEXT("Off to %s!"), *Order.Name));
		bRemount = true;
		RemountThing = Order.Thing;
		RemountSp = Order.Sp;
		Off();
		Me->TeleportToGeo(Order.Lat, Order.Lon);
	}
}

/** Steers the player along the way when they are being taken somewhere. */
void UEarthCompany::Steer(double Dt)
{
	AEarthWalkCharacter* Me = Player.Get();
	UEarthWalkNet* Room = Net.Get();
	double Px = 0.0, Pz = 0.0;
	if (!Me || !Room || !PlayerAt(Px, Pz))
	{
		return;
	}
	Me->ClearAutopilot();
	APlayerController* PC = Cast<APlayerController>(Me->GetController());
	if (bRemount && !Me->IsWaitingForGround())
	{
		// Arrived by jump: get back on, here.
		bRemount = false;
		Wanted = FEarthThing();
		Wanted.Thing = RemountThing;
		Wanted.Sp = RemountSp;
		Wanted.X = Px;
		Wanted.Z = Pz;
		Wanted.Yaw = PC ? (-PC->GetControlRotation().Yaw * UE_DOUBLE_PI) / 180.0 : 0.0;
		bWanted = true;
		WantedAt = FPlatformTime::Seconds();
		Room->SendRide(RemountThing, RemountSp);
	}
	if (!Trip.bOn)
	{
		return;
	}
	if (!Mine.bOn || Mine.Thing != Trip.Thing || Me->IsWaitingForGround())
	{
		Trip.bOn = false;
		return;
	}
	if (Me->IsSteering())
	{
		Trip.bOn = false;
		Notice(TEXT("You have the reins again."));
		return;
	}
	// Getting no nearer for five seconds (a wall in the way, a part of the world that will not load):
	// do the rest in one jump. Getting nearer means passing a point of the way, or closing on the next.
	const FVector2D Ahead = Trip.Path[Trip.I];
	const double Short = (Trip.Path.Num() - Trip.I) * 1000.0 + std::hypot(Ahead.X - Px, Ahead.Y - Pz);
	if (!Trip.bHasBest || Short < Trip.Best - 1.5)
	{
		Trip.bHasBest = true;
		Trip.Best = Short;
		Trip.Held = 0.0;
	}
	else
	{
		Trip.Held += Dt;
	}
	if (Trip.Held > 5.0)
	{
		const FTrip Was = Trip;
		Trip.bOn = false;
		Notice(FString::Printf(TEXT("The road gave out. Off to %s the quick way!"), *Was.Name));
		bRemount = true;
		RemountThing = Was.Thing;
		RemountSp = Was.Sp;
		Off();
		Me->TeleportToGeo(Was.EndLat, Was.EndLon);
		return;
	}
	// Aim a little way ahead along the path, so corners are rounded and not jerked through.
	while (Trip.I < Trip.Path.Num() - 1 && std::hypot(Trip.Path[Trip.I].X - Px, Trip.Path[Trip.I].Y - Pz) < 7.0)
	{
		++Trip.I;
	}
	const FVector2D Aim = Trip.Path[Trip.I];
	const double Dx = Aim.X - Px, Dz = Aim.Y - Pz;
	const double Left = std::hypot(Dx, Dz);
	const bool bLast = Trip.I == Trip.Path.Num() - 1;
	if (bLast && Left < ArrivedM)
	{
		Trip.bOn = false;
		Notice(FString::Printf(TEXT("Here we are: %s."), *Trip.Name));
		return;
	}
	if (Left < 1e-6)
	{
		return;
	}
	// East and south in the browser's terms; north and east in the engine's.
	Me->SetAutopilot(FVector2D(-Dz / Left, Dx / Left), Left < 20.0 && bLast ? 0.4 : 0.8);
	// Turn to face the way we are going, a little each frame, so the view follows the road.
	if (PC)
	{
		FRotator Look = PC->GetControlRotation();
		const double Want = (std::atan2(Dx, -Dz) * 180.0) / UE_DOUBLE_PI;
		const double MaxTurn = (2.2 * 180.0 / UE_DOUBLE_PI) * Dt;
		Look.Yaw += FMath::Clamp(FMath::FindDeltaAngleDegrees(Look.Yaw, Want), -MaxTurn, MaxTurn);
		PC->SetControlRotation(Look);
	}
}

void UEarthCompany::Stand(uint32 Thing, const FString& Sp, double X, double Z, double Yaw, double Gait, bool bMoving, double Lift, double Spin)
{
	double Y = 0.0;
	Hidden.Add(Thing);
	if (GroundFor(Sp, X, Z, Y))
	{
		FEarthThing Mount;
		Mount.Thing = Thing;
		Mount.Sp = Sp;
		Mount.X = X;
		Mount.Y = Y + Lift;
		Mount.Z = Z;
		Mount.Yaw = Yaw + Spin;
		Mount.Gait = Gait;
		Mount.bMoving = bMoving;
		Mount.bOutOfPlace = true;
		Mounts.Add(Mount);
	}
}

/** Adds everything doing as it was told to what is drawn in place of the timetable. */
void UEarthCompany::OrdersFrame(double Dt, double T)
{
	UEarthWalkNet* Room = Net.Get();
	if (!Room)
	{
		return;
	}
	const double NowMs = T * 1000.0;
	const double Clock = FPlatformTime::Seconds();
	for (auto It = Room->GetOrders().CreateIterator(); It; ++It)
	{
		const FEarthOrder& Order = It.Value();
		const uint32 Thing = It.Key();
		if (Order.Until <= NowMs)
		{
			Poses.Remove(Thing);
			It.RemoveCurrent();
			continue;
		}
		if (Hidden.Contains(Thing))
		{
			Poses.Remove(Thing); // somebody is riding it
			continue;
		}
		if (!EarthRigs::Find(Order.Sp) && !EarthMounts::Find(Order.Sp))
		{
			continue;
		}
		FOrderPose* Pose = Poses.Find(Thing);
		if (!Pose || Pose->At != Order.At)
		{
			// A new order: carry on from where it stands if this game has been drawing it, else from where it was when told.
			FOrderPose Fresh;
			if (Pose)
			{
				Fresh = *Pose;
			}
			else
			{
				GeoToScene(Order.Lat, Order.Lon, Fresh.X, Fresh.Z);
			}
			Fresh.At = Order.At;
			Pose = &Poses.Add(Thing, Fresh);
		}
		bool bGoal = false;
		double Gx = 0.0, Gz = 0.0;
		double StopAt = 0.3;
		if (Order.Act == TEXT("follow"))
		{
			bGoal = WhereIs(Order.By, Gx, Gz);
			StopAt = HeelM;
		}
		else if (Order.Act == TEXT("come") && Order.bHasTo)
		{
			GeoToScene(Order.ToLat, Order.ToLon, Gx, Gz);
			bGoal = true;
			StopAt = 1.6;
		}
		bool bMoving = false;
		if (bGoal)
		{
			const double Dx = Gx - Pose->X, Dz = Gz - Pose->Z;
			const double Left = std::hypot(Dx, Dz);
			if (Left > LostM)
			{
				// Left far behind: catch up in one go.
				Pose->X = Gx - (Dx / Left) * HeelM;
				Pose->Z = Gz - (Dz / Left) * HeelM;
			}
			else if (Left > StopAt)
			{
				const double Pace = PaceOf(Order.Sp) * (Left > 12.0 ? 1.6 : 1.0); // hurry when left behind
				const double Step = FMath::Min(Left - StopAt, Pace * Dt);
				Pose->X += (Dx / Left) * Step;
				Pose->Z += (Dz / Left) * Step;
				Pose->D += Step;
				Pose->Yaw = std::atan2(-Dx, -Dz); // facing the way it walks
				bMoving = Step > 0.001;
			}
		}
		const FTrick* Trick = Tricks.Find(Thing);
		const double U = Trick ? (Clock - Trick->Start) / TrickS : 2.0;
		if (Trick && U >= 1.0)
		{
			Tricks.Remove(Thing);
		}
		Stand(Thing, Order.Sp, Pose->X, Pose->Z, Pose->Yaw, Pose->D, bMoving, U < 1.0 ? std::sin(U * UE_DOUBLE_PI) * 1.1 : 0.0, U < 1.0 ? U * UE_DOUBLE_PI * 2.0 : 0.0);
	}
	for (auto It = Poses.CreateIterator(); It; ++It)
	{
		if (!Room->GetOrders().Contains(It.Key()))
		{
			It.RemoveCurrent();
		}
	}

	// Tricks by things that are otherwise going about their business: up, round, and back to it.
	for (auto It = Tricks.CreateIterator(); It; ++It)
	{
		if (Room->GetOrders().Contains(It.Key()))
		{
			continue;
		}
		const FTrick& Trick = It.Value();
		const double U = (Clock - Trick.Start) / TrickS;
		if (U >= 1.0 || Hidden.Contains(It.Key()))
		{
			It.RemoveCurrent();
			continue;
		}
		Stand(It.Key(), Trick.Sp, Trick.X, Trick.Z, Trick.Yaw, 0.0, false, std::sin(U * UE_DOUBLE_PI) * 1.1, U * UE_DOUBLE_PI * 2.0);
	}
}

// ------------------------------------------------------------------------------------------------

void UEarthCompany::Frame(AEarthWalkCharacter* InPlayer, double Dt, double T)
{
	Player = InPlayer;
	AEarthLife* Life = World.IsValid() ? World->GetLife() : nullptr;
	if (!InPlayer || !Life)
	{
		return;
	}
	Steer(Dt);
	RidingFrame(Dt, T);
	TalkFrame(Dt);
	Life->SetOutOfPlace(Hidden, Mounts);
	Hint = RideHint.IsEmpty() ? TalkHint : TalkHint.IsEmpty() ? RideHint : RideHint + TEXT("      ") + TalkHint;
	TestAids(Dt);
}

/**
 * -EWRide=<kind> hops on the nearest thing of that kind that this game can see, -EWTalk=<kind> walks
 * up to the nearest and says hello, and -EWSay=<words> then says that to it. For pictures and tests:
 * nobody has to be at the keyboard.
 */
void UEarthCompany::TestAids(double Dt)
{
	static const FString RideKind = []() { FString Kind; FParse::Value(FCommandLine::Get(), TEXT("-EWRide="), Kind); return Kind; }();
	static const FString TalkKind = []() { FString Kind; FParse::Value(FCommandLine::Get(), TEXT("-EWTalk="), Kind); return Kind; }();
	static const FString Words = []() { FString Text; FParse::Value(FCommandLine::Get(), TEXT("-EWSay="), Text); return Text.Replace(TEXT("_"), TEXT(" ")); }();
	AEarthWalkCharacter* Me = Player.Get();
	UEarthWalkNet* Room = Net.Get();
	AEarthLife* Life = World.IsValid() ? World->GetLife() : nullptr;
	double Px = 0.0, Pz = 0.0;
	if ((RideKind.IsEmpty() && TalkKind.IsEmpty()) || TestStep > 3 || !Me || !Room || !Life || !Room->IsConnected() || Me->IsWaitingForGround() || !PlayerAt(Px, Pz))
	{
		return;
	}
	TestClock += Dt;
	const auto Nearest = [&](const FString& Kind, FEarthThing& Out)
	{
		double Best = TNumericLimits<double>::Max();
		const TArray<FEarthThing>* const Lists[] = { &Life->GetNearby(), &Life->GetRideable(), &Mounts };
		for (const TArray<FEarthThing>* List : Lists)
		{
			for (const FEarthThing& Candidate : *List)
			{
				const double D = std::hypot(Candidate.X - Px, Candidate.Z - Pz);
				if (Candidate.Sp == Kind && D < Best)
				{
					Best = D;
					Out = Candidate;
				}
			}
		}
		return Best < TNumericLimits<double>::Max();
	};
	if (TestStep == 0 && TestClock > 4.0)
	{
		TestStep = 1;
		FEarthThing Found;
		if (!RideKind.IsEmpty() && !Mine.bOn && Nearest(RideKind, Found) && EarthMounts::Find(Found.Sp))
		{
			Wanted = Found;
			bWanted = true;
			WantedAt = FPlatformTime::Seconds();
			Room->SendRide(Found.Thing, Found.Sp);
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: asked to ride %s %u"), *Found.Sp, Found.Thing);
		}
		else if (!RideKind.IsEmpty())
		{
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: nothing of kind %s to ride near here"), *RideKind);
		}
	}
	else if (TestStep == 1 && TestClock > 7.0)
	{
		TestStep = 2;
		FEarthThing Found;
		if (!TalkKind.IsEmpty() && Nearest(TalkKind, Found))
		{
			if (!Mine.bOn)
			{
				// Walk up to it: three metres to the south, looking north at it.
				double Ground = 0.0;
				if (World->TerrainHeightAt(Found.X, Found.Z + 3.0, Ground))
				{
					Me->PlaceFeetAt(SceneToEngine(Found.X, Ground + 0.3, Found.Z + 3.0));
				}
			}
			To = Found;
			bTalking = true;
			Room->SendTalk(To.Thing, To.Sp);
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: said hello to %s %u"), *Found.Sp, Found.Thing);
		}
		else if (!TalkKind.IsEmpty())
		{
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: nothing of kind %s to talk to near here"), *TalkKind);
		}
	}
	else if (TestStep == 2 && TestClock > 10.0)
	{
		TestStep = 3;
		if (bTalking && !Words.IsEmpty())
		{
			Say(Words);
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: said \"%s\""), *Words);
		}
	}
	else if (TestStep == 3 && TestClock > 14.0)
	{
		TestStep = 4;
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: riding %s (seat %d), %d things out of place, %d bubbles, %d orders in force, hint \"%s\""),
			Mine.bOn ? *Mine.Sp : TEXT("nothing"), Mine.Seat, Mounts.Num(), Bubbles.Num(), Room->GetOrders().Num(), *Hint);
	}
}
