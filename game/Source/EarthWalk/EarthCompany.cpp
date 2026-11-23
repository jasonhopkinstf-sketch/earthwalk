#include "EarthCompany.h"

#include "EarthMiniMap.h"

#include "EarthLife.h"
#include "EarthLifeMotion.h"
#include "EarthLifeRigs.h"
#include "EarthRaceCourse.h"
#include "EarthTreasure.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkCharacter.h"
#include "EarthWorld.h"
#include "Engine/GameInstance.h"
#include "GameFramework/PlayerController.h"
#include "Camera/PlayerCameraManager.h"
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
		{ TEXT("donkey"), 6.0, 1.15, TEXT("donkey"), 0.0, false },
		{ TEXT("pig"), 4.0, 0.6, TEXT("pig"), 0.0, false },
		{ TEXT("goat"), 5.0, 0.75, TEXT("goat"), 0.0, false },
		{ TEXT("zebra"), 10.0, 1.3, TEXT("zebra"), 0.0, false },
		{ TEXT("elephant"), 5.0, 2.75, TEXT("elephant"), 4.5, false },
		{ TEXT("giraffe"), 8.0, 2.7, TEXT("giraffe"), 4.0, false },
		{ TEXT("bison"), 7.0, 1.6, TEXT("bison"), 0.0, false },
		{ TEXT("moose"), 8.0, 1.95, TEXT("moose"), 0.0, false },
		{ TEXT("reindeer"), 9.0, 1.25, TEXT("reindeer"), 0.0, false },
		{ TEXT("bear"), 6.0, 1.2, TEXT("bear"), 0.0, false },
		{ TEXT("lion"), 9.0, 1.05, TEXT("lion"), 0.0, false },
		{ TEXT("panda"), 3.0, 0.95, TEXT("panda"), 0.0, false },
		{ TEXT("tortoise"), 0.6, 0.3, TEXT("tortoise"), 0.0, false },
		{ TEXT("tractor"), 5.0, 1.35, TEXT("tractor"), 4.0, false, 9.0, 3.5, 3.2, 9.0, 2.3, 10.0 },
		{ TEXT("car"), 13.0, 1.5, TEXT("car"), 3.5, false, 27.0, 7.0, 7.5, 17.0, 2.6, 7.0 }, // up on the roof, where the view is not all bonnet
		{ TEXT("taxi"), 13.0, 1.5, TEXT("taxi"), 4.0, false, 27.0, 7.0, 7.5, 17.0, 2.6, 7.0 },
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
		{ TEXT("pig"), TEXT("pig"), 1.5, TalkReachM },
		{ TEXT("goat"), TEXT("goat"), 1.5, TalkReachM },
		{ TEXT("donkey"), TEXT("donkey"), 2.2, TalkReachM },
		{ TEXT("goose"), TEXT("goose"), 1.5, TalkReachM },
		{ TEXT("mouse"), TEXT("mouse"), 1.5, TalkReachM },
		{ TEXT("hedgehog"), TEXT("hedgehog"), 1.5, TalkReachM },
		{ TEXT("fox"), TEXT("fox"), 1.5, TalkReachM },
		{ TEXT("frog"), TEXT("frog"), 1.5, TalkReachM },
		{ TEXT("snail"), TEXT("snail"), 1.5, TalkReachM },
		{ TEXT("tortoise"), TEXT("tortoise"), 1.5, TalkReachM },
		{ TEXT("crab"), TEXT("crab"), 1.5, TalkReachM },
		{ TEXT("beaver"), TEXT("beaver"), 1.5, TalkReachM },
		{ TEXT("otter"), TEXT("otter"), 1.5, TalkReachM },
		{ TEXT("swan"), TEXT("swan"), 1.5, TalkReachM },
		{ TEXT("heron"), TEXT("heron"), 1.7, TalkReachM },
		{ TEXT("seagull"), TEXT("seagull"), 1.5, TalkReachM },
		{ TEXT("sparrow"), TEXT("sparrow"), 1.5, TalkReachM },
		{ TEXT("flamingo"), TEXT("flamingo"), 1.9, TalkReachM },
		{ TEXT("seal"), TEXT("seal"), 1.5, TalkReachM },
		{ TEXT("butterfly"), TEXT("butterfly"), 1.5, TalkReachM },
		{ TEXT("bee"), TEXT("bee"), 1.5, TalkReachM },
		{ TEXT("dragonfly"), TEXT("dragonfly"), 1.5, TalkReachM },
		{ TEXT("ladybird"), TEXT("ladybird"), 1.5, TalkReachM },
		{ TEXT("ant"), TEXT("ant"), 1.5, TalkReachM },
		{ TEXT("grasshopper"), TEXT("grasshopper"), 1.5, TalkReachM },
		{ TEXT("elephant"), TEXT("elephant"), 4.2, TalkReachM },
		{ TEXT("giraffe"), TEXT("giraffe"), 5.4, TalkReachM },
		{ TEXT("zebra"), TEXT("zebra"), 2.3, TalkReachM },
		{ TEXT("lion"), TEXT("lion"), 1.9, TalkReachM },
		{ TEXT("monkey"), TEXT("monkey"), 1.5, TalkReachM },
		{ TEXT("panda"), TEXT("panda"), 1.7, TalkReachM },
		{ TEXT("koala"), TEXT("koala"), 1.5, TalkReachM },
		{ TEXT("bear"), TEXT("bear"), 2.2, TalkReachM },
		{ TEXT("moose"), TEXT("moose"), 2.9, TalkReachM },
		{ TEXT("bison"), TEXT("bison"), 2.5, TalkReachM },
		{ TEXT("reindeer"), TEXT("reindeer"), 2.4, TalkReachM },
		{ TEXT("capybara"), TEXT("capybara"), 1.5, TalkReachM },
		{ TEXT("marmot"), TEXT("marmot"), 1.5, TalkReachM },
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
			{ TEXT("zebra"), 7.0 }, { TEXT("reindeer"), 7.0 }, { TEXT("fox"), 6.0 }, { TEXT("donkey"), 4.0 }, { TEXT("goat"), 4.0 }, { TEXT("pig"), 3.0 }, { TEXT("monkey"), 5.0 }, { TEXT("elephant"), 4.0 }, { TEXT("giraffe"), 5.0 }, { TEXT("bison"), 4.0 }, { TEXT("moose"), 5.0 }, { TEXT("bear"), 4.0 }, { TEXT("lion"), 6.0 }, { TEXT("mouse"), 3.0 }, { TEXT("frog"), 3.0 }, { TEXT("snail"), 0.1 }, { TEXT("tortoise"), 0.4 },
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

void EarthMounts::StepCar(FEarthCar& Car, const FEarthMount& How, double Dt, double Throttle, double Steer, bool bHandbrake)
{
	const double Sin = std::sin(Car.Heading), Cos = std::cos(Car.Heading);
	double Along = Car.Vx * Sin - Car.Vz * Cos; // forwards is (sin, -cos)
	double Across = Car.Vx * Cos + Car.Vz * Sin;
	const auto Sign = [](double V) { return V > 0.0 ? 1.0 : V < 0.0 ? -1.0 : 0.0; };
	if (Throttle > 0.0)
	{
		Along += (Along < -0.5 ? How.Brake : How.Pull * FMath::Max(0.0, 1.0 - Along / How.Top)) * Dt;
	}
	else if (Throttle < 0.0)
	{
		Along -= (Along > 0.5 ? How.Brake : How.Pull * 0.7 * FMath::Max(0.0, 1.0 + Along / How.Reverse)) * Dt;
	}
	else
	{
		Along -= Sign(Along) * FMath::Min(FMath::Abs(Along), (1.4 + 0.012 * Along * Along) * Dt); // rolling to a stop
	}
	if (bHandbrake)
	{
		Along -= Sign(Along) * FMath::Min(FMath::Abs(Along), How.Brake * 0.3 * Dt);
	}
	Along = FMath::Clamp(Along, -How.Reverse, How.Top);
	Across *= std::exp(-(bHandbrake ? How.Grip * 0.16 : How.Grip) * Dt);
	// The faster it goes, the less the wheels are turned, and they take a moment to turn.
	const double Lock = 0.62 / (1.0 + FMath::Abs(Along) / 6.0 + (Along / 16.0) * (Along / 16.0));
	Car.Steer += (Steer * Lock - Car.Steer) * (1.0 - std::exp(-7.0 * Dt));
	Car.Turn = (Along / How.Base) * std::tan(Car.Steer) * (bHandbrake ? 1.45 : 1.0);
	Car.Heading += Car.Turn * Dt;
	Car.Vx = Sin * Along + Cos * Across;
	Car.Vz = -Cos * Along + Sin * Across;
	Car.Speed = Along;
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
		Room->OnTaxi.AddUObject(this, &UEarthCompany::OnTaxi);
		Room->OnTreasure.AddUObject(this, &UEarthCompany::OnTreasure);
		Room->OnRace.AddUObject(this, &UEarthCompany::OnRace);
		Room->OnTrick.AddUObject(this, &UEarthCompany::OnTrick);
	}
}

void UEarthCompany::OnTreasure(double Lat, double Lon)
{
	AEarthWorld* Earth = World.Get();
	const AEarthWalkCharacter* Me = Player.Get();
	if (!Earth || !Me || !Earth->GetWorld())
	{
		return;
	}
	// Three and a half metres ahead of where the finder stood, the way I am looking, on the ground there.
	const APlayerController* PC = Cast<APlayerController>(Me->GetController());
	const double Yaw = PC ? PC->GetControlRotation().Yaw : Me->GetActorRotation().Yaw;
	const FVector Ahead = FRotator(0.0, Yaw, 0.0).Vector();
	FVector At = Earth->GeoToWorld(Lat, Lon, 0.0) + Ahead * 350.0;
	double Ground = 0.0;
	At.Z = Earth->TerrainHeightAt(At.Y / 100.0, -At.X / 100.0, Ground) ? Ground * 100.0 : Me->FeetLocation().Z;
	// Its front, where the lock is, faces the finder.
	if (AEarthTreasure* Chest = Earth->GetWorld()->SpawnActor<AEarthTreasure>(At, FRotator(0.0, Yaw + 180.0, 0.0)))
	{
		Chest->Build(Earth);
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

void UEarthCompany::MapMarks(TArray<FEarthMapMark>& Out, TArray<FVector2D>& OutWay, FString& OutGoing) const
{
	UEarthWalkNet* Room = Net.Get();
	if (!Room)
	{
		return;
	}
	const FString& Me = Room->GetMyId();
	// Where a thing is being drawn out of its place, if it is.
	const auto Drawn = [this](uint32 Thing, double& X, double& Z)
	{
		for (const FEarthThing& Mount : Mounts)
		{
			if (Mount.Thing == Thing)
			{
				X = Mount.X;
				Z = Mount.Z;
				return true;
			}
		}
		return false;
	};
	const auto Add = [&Out](FEarthMapMark::EKind Kind, double X, double Z, const FString& Label)
	{
		FEarthMapMark& Mark = Out.AddDefaulted_GetRef();
		Mark.Kind = Kind;
		Mark.X = X;
		Mark.Z = Z;
		Mark.Label = Label;
	};

	if (const FEarthOwnCar* Car = Room->GetCars().Find(Me))
	{
		if (!(Mine.bOn && Mine.Thing == Car->Thing))
		{
			double X = 0.0, Z = 0.0;
			if (!Drawn(Car->Thing, X, Z))
			{
				GeoToScene(Car->Lat, Car->Lon, X, Z);
			}
			Add(FEarthMapMark::EKind::MyCar, X, Z, TEXT("your car"));
		}
	}
	for (const TPair<uint32, FEarthTaxi>& Pair : Room->GetTaxis())
	{
		double X = 0.0, Z = 0.0;
		if (Pair.Value.By == Me && !(Mine.bOn && Mine.Thing == Pair.Key) && Drawn(Pair.Key, X, Z))
		{
			Add(FEarthMapMark::EKind::Taxi, X, Z, Pair.Value.Name.IsEmpty() ? FString(TEXT("your taxi")) : Pair.Value.Name);
		}
	}

	const FEarthRace& Race = Room->GetRace();
	if (Race.bOn && Race.State != TEXT("over"))
	{
		const FEarthRunner* Runner = Race.Runners.FindByPredicate([&Me](const FEarthRunner& Each) { return Each.Id == Me; });
		if (!Runner || !Runner->bFinished)
		{
			const int32 Next = Runner ? Runner->Gate : 0;
			for (int32 K = Next; K < Race.Gates.Num(); ++K)
			{
				double X = 0.0, Z = 0.0;
				GeoToScene(Race.Gates[K].X, Race.Gates[K].Y, X, Z);
				Add(FEarthMapMark::EKind::Gate, X, Z, K != Next ? FString() : !Runner ? FString(TEXT("the race")) : K == Race.Gates.Num() - 1 ? FString(TEXT("finish")) : FString(TEXT("next gate")));
				if (!Runner)
				{
					break; // not in it: just where it starts
				}
			}
		}
	}

	double Px = 0.0, Pz = 0.0;
	if (Trip.bOn && Trip.Path.Num() > 0 && PlayerAt(Px, Pz))
	{
		OutGoing = Trip.Name;
		OutWay.Add(FVector2D(Px, Pz));
		for (int32 K = FMath::Clamp(Trip.I, 0, Trip.Path.Num() - 1); K < Trip.Path.Num(); ++K)
		{
			OutWay.Add(Trip.Path[K]);
		}
		Add(FEarthMapMark::EKind::Goal, Trip.Path.Last().X, Trip.Path.Last().Y, Trip.Name);
	}
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
	// A door within reach, and nothing to ride: go in or out.
	if (bDoorNear && !bNear)
	{
		UseDoor();
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
	const double Yaw = Me->FacingYaw(); // asked before the mount is given up: at the wheel it is the way the car points
	Me->SetMount(nullptr);
	Me->SetCarried(false);
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
		const double Yaw = Me->FacingYaw();
		Ridden(TEXT("me"), Mine.Thing, Mine.Sp, Feet.Y / 100.0, -Feet.X / 100.0, Feet.Z / 100.0, (-Yaw * UE_DOUBLE_PI) / 180.0, Dt);
		if (Me->IsDriving() && Mounts.Num() > 0)
		{
			// A driven car sits to the slope of the ground under its wheels, leans out of a bend, and dips its nose under braking.
			FEarthThing& Mount = Mounts.Last();
			const FEarthCar& Car = Me->GetCar();
			const double Sin = std::sin(Car.Heading), Cos = std::cos(Car.Heading);
			const auto HeightAt = [&](double Along, double Across)
			{
				double H = Mount.Y;
				Earth->TerrainHeightAt(Mount.X + Sin * Along + Cos * Across, Mount.Z - Cos * Along + Sin * Across, H);
				return H;
			};
			const double Slope = std::atan2(HeightAt(1.3, 0.0) - HeightAt(-1.3, 0.0), 2.6);
			const double Bank = std::atan2(HeightAt(0.0, 0.8) - HeightAt(0.0, -0.8), 1.6);
			const double Lean = FMath::Clamp(Car.Turn * Car.Speed * 0.006, -0.09, 0.09);
			Mount.Pitch = FMath::Clamp(Slope, -0.5, 0.5);
			Mount.Roll = FMath::Clamp(-Bank, -0.4, 0.4) + Lean;
		}
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
	TaxiFrame(T); // and taxis on their way to whoever called them
	GarageFrame(); // and players' own cars, standing or driven, in their paint
	PetFrame(Dt); // and everyone's companion, trotting after them
	GardenFrame(T); // and the young animals in the gardens of houses near here

	// ---- what would E hop on?
	bNear = false;
	double Px = 0.0, Pz = 0.0;
	if (!Mine.bOn && !bWanted && !Me->IsFlying() && !Me->IsWaitingForGround() && PlayerAt(Px, Pz))
	{
		double Best = TNumericLimits<double>::Max();
		const auto Consider = [&](const FEarthThing& Candidate)
		{
			const FEarthMount* Mount = EarthMounts::Find(Candidate.Sp);
			if (!Mount || Candidate.bNoRide)
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
		TalkHint = bTalking ? FString()
			: bTalkNear ? FString::Printf(TEXT("T: talk to %s"), *Title(TalkNear))
			: FString();
	}
	const double Now = FPlatformTime::Seconds();
	Bubbles.RemoveAll([Now](const FBubble& Bubble) { return Now > Bubble.Until; });
	// What a thing said goes along with it when it is on the move here: a taxi telling its story as it
	// drives would otherwise leave each part of it standing in the road behind.
	for (FBubble& Bubble : Bubbles)
	{
		for (const FEarthThing& Mount : Mounts)
		{
			if (Mount.Thing != Bubble.Thing)
			{
				continue;
			}
			if (const FCalled* Row = CalledRow(Mount.Sp))
			{
				Bubble.Where = SceneToEngine(Mount.X, Mount.Y + Row->BubbleAt, Mount.Z);
			}
			break;
		}
	}
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
	Spoke = Said.Thing;
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
	// Getting no nearer (a wall in the way, a part of the world that will not load). On a road, after a
	// second and a half the car is set down ten metres farther along it, past whatever it met: a parked
	// van, the corner of a house the map has standing in the street. Only when that has not helped a
	// dozen times, or there is no road to follow, is the rest done in one jump. Getting nearer means
	// passing a point of the way, or closing on the next.
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
	// -EWTripLog: where the trip has got to, once a second, for tests.
	static const bool bTripLog = FParse::Param(FCommandLine::Get(), TEXT("EWTripLog"));
	static double TripLogAt = 0.0;
	if (bTripLog && FPlatformTime::Seconds() - TripLogAt > 1.0)
	{
		TripLogAt = FPlatformTime::Seconds();
		const FVector Going = Me->GetVelocity();
		double Ground = 0.0;
		const bool bGround = World.IsValid() && World->TerrainHeightAt(Px, Pz, Ground);
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: trip: at %.1f east %.1f south, %.1f m up (ground %s%.1f), point %d of %d is %.1f m off, %.1f m/s, held %.1f s, first point %.1f %.1f"),
			Px, Pz, Me->GetActorLocation().Z / 100.0, bGround ? TEXT("") : TEXT("unknown "), Ground, Trip.I, Trip.Path.Num(), std::hypot(Ahead.X - Px, Ahead.Y - Pz), Going.Size2D() / 100.0, Trip.Held, Trip.Path[0].X, Trip.Path[0].Y);
	}
	// -EWTripHop: eight seconds into a trip the car is held up once, as if by a wall, for tests.
	static const bool bHopTest = FParse::Param(FCommandLine::Get(), TEXT("EWTripHop"));
	Trip.Age += Dt;
	if (bHopTest && Trip.Age > 8.0 && Trip.Hops == 0)
	{
		Trip.Held = 2.0;
	}
	if (Trip.Held > 1.5 && Trip.Path.Num() > 1 && Trip.Hops < 12)
	{
		int32 J = Trip.I;
		while (J < Trip.Path.Num() - 1 && std::hypot(Trip.Path[J].X - Px, Trip.Path[J].Y - Pz) < 10.0)
		{
			++J;
		}
		double GroundHere = 0.0, GroundThere = 0.0;
		if (World.IsValid() && World->TerrainHeightAt(Px, Pz, GroundHere) && World->TerrainHeightAt(Trip.Path[J].X, Trip.Path[J].Y, GroundThere))
		{
			const FVector Here = Me->GetActorLocation();
			Me->SetActorLocation(FVector(-Trip.Path[J].Y * 100.0, Trip.Path[J].X * 100.0, Here.Z + (GroundThere - GroundHere) * 100.0 + 30.0), false, nullptr, ETeleportType::TeleportPhysics);
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: trip: held up at %.1f east %.1f south; set down at point %d of %d, %.1f m on"), Px, Pz, J, Trip.Path.Num(), std::hypot(Trip.Path[J].X - Px, Trip.Path[J].Y - Pz));
			++Trip.Hops;
			Trip.I = J;
			Trip.bHasBest = false;
			Trip.Held = 0.0;
			return;
		}
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

void UEarthCompany::Stand(uint32 Thing, const FString& Sp, double X, double Z, double Yaw, double Gait, bool bMoving, double Lift, double Spin, double Tip, double Lean)
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
		Mount.Pitch = Tip;
		Mount.Roll = Lean;
		Mount.Gait = Gait;
		Mount.bMoving = bMoving;
		Mount.bOutOfPlace = true;
		Mounts.Add(Mount);
	}
}

void UEarthCompany::OnTrick(const FString& MemberId, uint32 Thing, const FString& Sp, const FString& Trick)
{
	FAct Act;
	Act.Trick = Trick;
	Act.Start = FPlatformTime::Seconds();
	Acts.Add(Thing, Act);
}

void UEarthCompany::Hop(const FString& MemberId)
{
	const UEarthWalkNet* Room = Net.Get();
	if (!Room)
	{
		return;
	}
	const FEarthPeer* Peer = Room->GetPeers().Find(MemberId);
	const FEarthPet Pet = MemberId == Room->GetMyId() ? Room->GetMyPet() : Peer ? Peer->Pet : FEarthPet();
	if (Pet.bOn && !Acts.Contains(Pet.Thing))
	{
		OnTrick(MemberId, Pet.Thing, Pet.Sp, TEXT("jump"));
	}
}

/**
 * The gardens of houses that are lived in: the young animals their owners are raising, ambling about
 * before the front door for everybody to see, each at the size it has grown to. As garden.js.
 */
void UEarthCompany::GardenFrame(double T)
{
	const UEarthWalkNet* Room = Net.Get();
	const AEarthWorld* Earth = World.Get();
	double Px = 0.0, Pz = 0.0;
	if (!Room || !Earth || !PlayerAt(Px, Pz))
	{
		return;
	}
	constexpr double SeeM = 160.0, OutM = 3.1, ApartM = 2.6, RoamM = 0.65;
	for (const TPair<FString, FEarthLived>& Pair : Room->GetHomes())
	{
		const FEarthLived& Home = Pair.Value;
		if (Home.Garden.Num() == 0)
		{
			continue;
		}
		double DoorX = 0.0, DoorZ = 0.0;
		GeoToScene(Home.Lat, Home.Lon, DoorX, DoorZ);
		if (std::hypot(DoorX - Px, DoorZ - Pz) > SeeM)
		{
			continue;
		}
		const double Yaw = (Home.Yaw * UE_DOUBLE_PI) / 180.0; // the way out of the door
		const double Ox = std::sin(Yaw), Oz = -std::cos(Yaw), Sx = std::cos(Yaw), Sz = std::sin(Yaw);
		for (int32 i = 0; i < Home.Garden.Num(); ++i)
		{
			const uint32 Hashed = EarthLife::Hash32(static_cast<uint32>(Home.Id), 0x47415244u + i);
			const uint32 Thing = Hashed ? Hashed : 1;
			const double Side = (i - (Home.Garden.Num() - 1) / 2.0) * ApartM;
			// Each ambles round a spot of its own, some one way and some the other.
			const double Turn = i % 2 ? -1.0 : 1.0;
			const double Phase = Turn * (T * 0.22 + i * 1.9);
			const double X = DoorX + Ox * OutM + Sx * Side + std::cos(Phase) * RoamM;
			const double Z = DoorZ + Oz * OutM + Sz * Side + std::sin(Phase) * RoamM;
			double Y = 0.0;
			if (!GroundFor(Home.Garden[i].Key, X, Z, Y))
			{
				continue;
			}
			const double Dx = -std::sin(Phase) * Turn, Dz = std::cos(Phase) * Turn; // the way it is going
			Hidden.Add(Thing);
			FEarthThing Mount;
			Mount.Thing = Thing;
			Mount.Sp = Home.Garden[i].Key;
			Mount.X = X;
			Mount.Y = Y;
			Mount.Z = Z;
			Mount.Yaw = std::atan2(-Dx, -Dz);
			Mount.Gait = FMath::Abs(Phase) * RoamM;
			Mount.bMoving = true;
			Mount.bOutOfPlace = true;
			Mount.Scale = FMath::Clamp(Home.Garden[i].Value, 0.3, 1.2);
			Mount.bNoRide = true;
			Mounts.Add(Mount);
		}
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
// Taxis
// ------------------------------------------------------------------------------------------------

/**
 * Companions (pets.js). Solving a riddle wins its answer as an animal that keeps its player company; a
 * lost animal being taken home walks along the same way. Every game works a companion out for itself
 * from where its player is, so friends agree to within a step or two.
 */
void UEarthCompany::PetFrame(double Dt)
{
	const UEarthWalkNet* Room = Net.Get();
	const AEarthWalkCharacter* Me = Player.Get();
	if (!Room || !Me)
	{
		return;
	}
	// How fast each kind keeps up, in metres a second; anything not listed trots.
	static const TMap<FString, double> Pace = {
		{ TEXT("snail"), 1.5 }, { TEXT("tortoise"), 1.8 }, { TEXT("ladybird"), 2.0 }, { TEXT("crab"), 3.0 }, { TEXT("frog"), 4.0 }, { TEXT("mouse"), 4.0 },
		{ TEXT("hedgehog"), 3.0 }, { TEXT("penguin"), 3.0 }, { TEXT("duck"), 3.5 }, { TEXT("goose"), 4.0 }, { TEXT("cow"), 5.0 }, { TEXT("panda"), 4.5 }, { TEXT("koala"), 3.0 },
	};
	constexpr double Trot = 7.0;
	constexpr double PetLostM = 60.0;
	TSet<uint32> Live;
	const auto Keep = [&](const FEarthPet& Pet, bool bOwner, double Ox, double Oz)
	{
		const bool bBig = EarthMounts::Find(Pet.Sp) != nullptr;
		if (!Pet.bOn || !bOwner || (!EarthRigs::Find(Pet.Sp) && !bBig))
		{
			return;
		}
		Live.Add(Pet.Thing);
		if (Hidden.Contains(Pet.Thing))
		{
			PetPoses.Remove(Pet.Thing); // being ridden: it is drawn under its rider
			return;
		}
		FOrderPose* Pose = PetPoses.Find(Pet.Thing);
		// A little behind and to one side of its player, so it is in view when they look round.
		const double Heel = bBig ? 2.6 : 1.6; // the big ones keep a little further off
		const double Dx = Ox - (Pose ? Pose->X : Ox - Heel), Dz = Oz - (Pose ? Pose->Z : Oz);
		const double Left = std::hypot(Dx, Dz);
		if (!Pose || Left > PetLostM)
		{
			FOrderPose Fresh;
			Fresh.X = Ox - (Left > 0.0 ? (Dx / Left) * Heel : Heel);
			Fresh.Z = Oz - (Left > 0.0 ? (Dz / Left) * Heel : 0.0);
			Fresh.Yaw = Pose ? Pose->Yaw : 0.0;
			Pose = &PetPoses.Add(Pet.Thing, Fresh);
		}
		bool bMoving = false;
		if (Left > Heel && Left <= PetLostM)
		{
			const double* Own = Pace.Find(Pet.Sp);
			const double Speed = (Own ? *Own : Trot) * (Left > 8.0 ? 2.2 : 1.0); // hurry when left behind
			const double Step = FMath::Min(Left - Heel, Speed * Dt);
			Pose->X += (Dx / Left) * Step;
			Pose->Z += (Dz / Left) * Step;
			Pose->D += Step;
			Pose->Yaw = std::atan2(-Dx, -Dz);
			bMoving = Step > 0.001;
		}
		Stand(Pet.Thing, Pet.Sp, Pose->X, Pose->Z, Pose->Yaw, Pose->D, bMoving, 0.0, 0.0);
	};
	// A companion in the middle of a trick stays where it began and is drawn doing it (perform in pets.js):
	// how long each takes, and where and how it is drawn so much of the way through.
	const auto Perform = [&](const FEarthPet& Pet) -> bool
	{
		const FAct* Act = Pet.bOn ? Acts.Find(Pet.Thing) : nullptr;
		FOrderPose* Pose = Act ? PetPoses.Find(Pet.Thing) : nullptr;
		if (!Act || !Pose || Hidden.Contains(Pet.Thing))
		{
			return false;
		}
		static const TMap<FString, double> Takes = { { TEXT("sit"), 2.6 }, { TEXT("spin"), 1.7 }, { TEXT("jump"), 1.5 }, { TEXT("bow"), 2.2 }, { TEXT("fetch"), 4.2 }, { TEXT("hoop"), 2.2 }, { TEXT("dance"), 3.6 } };
		const double* Seconds = Takes.Find(Act->Trick);
		const double U = Seconds ? (FPlatformTime::Seconds() - Act->Start) / *Seconds : 2.0;
		constexpr double FetchM = 7.0, HoopM = 4.4;
		const double Fx = -std::sin(Pose->Yaw), Fz = -std::cos(Pose->Yaw); // the way it faces
		if (U >= 1.0)
		{
			if (Act->Trick == TEXT("hoop"))
			{
				Pose->X += Fx * HoopM; // it landed further on
				Pose->Z += Fz * HoopM;
			}
			Acts.Remove(Pet.Thing);
			return false;
		}
		const double Hold = FMath::Min3(1.0, U * 5.0, (1.0 - U) * 5.0); // up to full and back again, holding in between
		double X = Pose->X, Z = Pose->Z, Yaw = Pose->Yaw, Lift = 0.0, Tip = 0.0, Lean = 0.0, Gait = Pose->D;
		bool bMoving = false;
		if (Act->Trick == TEXT("sit"))
		{
			Tip = 0.6 * Hold;
		}
		else if (Act->Trick == TEXT("bow"))
		{
			Tip = -0.5 * Hold;
		}
		else if (Act->Trick == TEXT("spin"))
		{
			Yaw += U * UE_DOUBLE_PI * 4.0;
		}
		else if (Act->Trick == TEXT("jump"))
		{
			Lift = FMath::Abs(std::sin(U * UE_DOUBLE_PI * 2.0)) * 1.1;
		}
		else if (Act->Trick == TEXT("dance"))
		{
			X += std::cos(Pose->Yaw) * std::sin(U * UE_DOUBLE_PI * 6.0) * 0.5;
			Z += -std::sin(Pose->Yaw) * std::sin(U * UE_DOUBLE_PI * 6.0) * 0.5;
			Lift = FMath::Abs(std::sin(U * UE_DOUBLE_PI * 12.0)) * 0.28;
			Lean = std::sin(U * UE_DOUBLE_PI * 6.0) * 0.25;
			Yaw += std::sin(U * UE_DOUBLE_PI * 4.0) * 0.6;
		}
		else if (Act->Trick == TEXT("fetch"))
		{
			// Out to where the ball would be and back (this game draws no ball).
			const double S = FetchM * (U < 0.5 ? U * 2.0 : (1.0 - U) * 2.0);
			X += Fx * S;
			Z += Fz * S;
			Yaw += U >= 0.5 ? UE_DOUBLE_PI : 0.0;
			bMoving = true;
			Gait += FetchM * 2.0 * U;
		}
		else if (Act->Trick == TEXT("hoop"))
		{
			// A run and a leap, as through a hoop (this game draws no hoop).
			X += Fx * HoopM * U;
			Z += Fz * HoopM * U;
			Lift = std::sin(U * UE_DOUBLE_PI) * 0.95;
			bMoving = true;
			Gait += HoopM * U;
		}
		Live.Add(Pet.Thing);
		Stand(Pet.Thing, Pet.Sp, X, Z, Yaw, Gait, bMoving, Lift, 0.0, Tip, Lean);
		return true;
	};
	double Px = 0.0, Pz = 0.0;
	if (!Me->IsWaitingForGround() && PlayerAt(Px, Pz) && !Perform(Room->GetMyPet()))
	{
		Keep(Room->GetMyPet(), true, Px, Pz);
	}
	for (const TPair<FString, FEarthPeer>& Pair : Room->GetPeers())
	{
		double Ox = 0.0, Oz = 0.0;
		if (!Perform(Pair.Value.Pet))
		{
			Keep(Pair.Value.Pet, WhereIs(Pair.Key, Ox, Oz), Ox, Oz);
		}
	}
	for (auto It = PetPoses.CreateIterator(); It; ++It)
	{
		if (!Live.Contains(It.Key()))
		{
			It.RemoveCurrent();
		}
	}
}

// ------------------------------------------------------------------------------------------------
// Races (race.js): the server makes the course and says who has passed which gate
// ------------------------------------------------------------------------------------------------

/** The race has changed: say so when it is news. */
void UEarthCompany::OnRace()
{
	const UEarthWalkNet* Room = Net.Get();
	if (!Room)
	{
		return;
	}
	const FEarthRace& Race = Room->GetRace();
	const FString Key = Race.bOn ? FString::Printf(TEXT("%s:%.0f"), *Race.By, Race.Made) : FString();
	if (Key != CourseKey)
	{
		CourseKey = Key;
		CourseShown.Reset();
		if (Race.bOn)
		{
			Notice(Race.By == Room->GetMyId()
				? FString::Printf(TEXT("Your race is set up: %.0f metres, %d gates. Press R to start it when everyone who wants to is in."), Race.Metres, Race.Gates.Num())
				: FString::Printf(TEXT("%s has set up a race of %.0f metres. Press R to join in."), *Race.ByName, Race.Metres));
		}
	}
}

void UEarthCompany::KeyRace(const FString& Word)
{
	UEarthWalkNet* Room = Net.Get();
	if (!Room || !Room->IsConnected())
	{
		return;
	}
	const FEarthRace& Race = Room->GetRace();
	const bool bIn = Race.Runners.ContainsByPredicate([Room](const FEarthRunner& Runner) { return Runner.Id == Room->GetMyId(); });
	if (Word == TEXT("stop") || Word == TEXT("leave"))
	{
		if (Race.bOn)
		{
			Room->SendRace(TEXT("stop"));
		}
		else
		{
			Notice(TEXT("There is no race just now."));
		}
	}
	else if (!Race.bOn || Race.State == TEXT("over"))
	{
		Notice(TEXT("Setting up a race along the roads here..."));
		Room->SendRace(TEXT("make"));
	}
	else if (Race.State != TEXT("open"))
	{
		return;
	}
	else if (!bIn)
	{
		Room->SendRace(TEXT("join"));
	}
	else if (Race.By == Room->GetMyId())
	{
		Room->SendRace(TEXT("go"));
	}
	else
	{
		Notice(FString::Printf(TEXT("You are in. %s says when to go."), *Race.ByName));
	}
}

/** Stands the gates up, lights the next one, and writes the countdown and the list of runners. */
void UEarthCompany::RaceFrame(double T)
{
	const UEarthWalkNet* Room = Net.Get();
	AEarthWorld* Earth = World.Get();
	if (!Room || !Earth)
	{
		return;
	}
	const FEarthRace& Race = Room->GetRace();
	if (!Race.bOn)
	{
		RacePanel.Reset();
		RaceCount.Reset();
		if (AEarthRaceCourse* Old = Course.Get())
		{
			Old->Destroy();
		}
		Course.Reset();
		return;
	}
	const auto Clock = [](double Ms)
	{
		const double Seconds = FMath::Max(0.0, Ms) / 1000.0;
		return FString::Printf(TEXT("%d:%04.1f"), FMath::FloorToInt32(Seconds / 60.0), FMath::Fmod(Seconds, 60.0));
	};
	const double NowMs = T * 1000.0;
	const FEarthRunner* Me = Race.Runners.FindByPredicate([Room](const FEarthRunner& Runner) { return Runner.Id == Room->GetMyId(); });

	// The gates: stood up for a new course, when I pass one, and again while the ground under some has yet to arrive.
	const int32 MyGate = Me ? Me->Gate : -1;
	const bool bBeacon = Me && !Me->bFinished && Race.State != TEXT("over");
	const FString Shown = FString::Printf(TEXT("%s/%d/%d"), *CourseKey, MyGate, bBeacon ? 1 : 0);
	const double Now = FPlatformTime::Seconds();
	if (Shown != CourseShown || (CourseRetryAt > 0.0 && Now > CourseRetryAt))
	{
		AEarthRaceCourse* Gates = Course.Get();
		if (!Gates && Earth->GetWorld())
		{
			Gates = Earth->GetWorld()->SpawnActor<AEarthRaceCourse>();
			Course = Gates;
		}
		if (Gates)
		{
			CourseShown = Shown;
			CourseRetryAt = Gates->Rebuild(Earth, Race, MyGate, bBeacon) < Race.Gates.Num() ? Now + 1.0 : 0.0;
		}
	}

	// The countdown, large, and "GO!" for a moment after it.
	const bool bGo = Race.State == TEXT("go");
	const double Until = Race.StartAt - NowMs;
	RaceCount = !bGo ? FString() : Until > 0.0 ? FString::FromInt(FMath::CeilToInt32(Until / 1000.0)) : Until > -1200.0 ? FString(TEXT("GO!")) : FString();

	// Who is in, how far along, and what R does now.
	TArray<FString> Lines;
	const int32 Gates = Race.Gates.Num();
	if (Race.State == TEXT("open"))
	{
		TArray<FString> In;
		for (const FEarthRunner& Runner : Race.Runners)
		{
			In.Add(Runner.Name);
		}
		Lines.Add(Race.Kind == TEXT("agility") ? FString::Printf(TEXT("Agility course by %s: %d obstacles"), *Race.ByName, Gates) : FString::Printf(TEXT("Race by %s: %.0f m, %d gates"), *Race.ByName, Race.Metres, Gates));
		Lines.Add(FString::Printf(TEXT("In: %s"), *FString::Join(In, TEXT(", "))));
		Lines.Add(!Me ? FString(TEXT("R: join in")) : Race.By == Room->GetMyId() ? FString(TEXT("R: start the race")) : FString::Printf(TEXT("Waiting for %s to say go"), *Race.ByName));
	}
	else
	{
		const bool bRunning = bGo && Until <= 0.0;
		if (Me && !Me->bFinished && bRunning)
		{
			Lines.Add(FString::Printf(TEXT("Gate %d of %d  ·  %s"), FMath::Min(Me->Gate + 1, Gates), Gates, *Clock(NowMs - Race.StartAt)));
		}
		else if (bGo && Until > 0.0)
		{
			Lines.Add(TEXT("Get to the green start gate..."));
		}
		else if (Race.State == TEXT("over"))
		{
			Lines.Add(TEXT("The race is over"));
		}
		// Finishers first, by their time; then whoever has passed the most gates.
		TArray<FEarthRunner> Order = Race.Runners;
		Order.StableSort([](const FEarthRunner& A, const FEarthRunner& B)
		{
			if (A.bFinished != B.bFinished)
			{
				return A.bFinished;
			}
			return A.bFinished ? A.TimeMs < B.TimeMs : A.Gate > B.Gate;
		});
		for (int32 i = 0; i < Order.Num(); ++i)
		{
			Lines.Add(FString::Printf(TEXT("%d. %s  %s"), i + 1, *Order[i].Name, Order[i].bFinished ? *Clock(Order[i].TimeMs) : *FString::Printf(TEXT("%d/%d"), Order[i].Gate, Gates)));
		}
		if (Race.State == TEXT("over"))
		{
			Lines.Add(TEXT("R: set up another"));
		}
	}
	RacePanel = FString::Join(Lines, TEXT("\n"));
}

void UEarthCompany::CallCar(bool bAway)
{
	if (UEarthWalkNet* Room = Net.Get())
	{
		Room->SendGarage(bAway ? TEXT("away") : TEXT("call"));
		if (Room->IsConnected())
		{
			Notice(bAway ? TEXT("Your car has gone back to its garage.") : TEXT("Your car is on its way. Press E beside it to get in."));
		}
	}
}

/**
 * Players' own cars (garage.js). Each that nobody is driving stands where it was called to, or left;
 * and whether standing or driven it keeps its owner's body and paint.
 */
void UEarthCompany::GarageFrame()
{
	const UEarthWalkNet* Room = Net.Get();
	if (!Room)
	{
		return;
	}
	for (const TPair<FString, FEarthOwnCar>& Pair : Room->GetCars())
	{
		const FEarthOwnCar& Car = Pair.Value;
		bool bDrawn = false;
		for (FEarthThing& Mount : Mounts)
		{
			if (Mount.Thing == Car.Thing)
			{
				// Being driven: it is drawn under its driver, in its own look.
				Mount.bOwnLook = true;
				Mount.Body = Car.Body;
				Mount.Paint = Car.Paint;
				bDrawn = true;
			}
		}
		if (bDrawn || Hidden.Contains(Car.Thing))
		{
			continue;
		}
		Hidden.Add(Car.Thing);
		double X = 0.0, Z = 0.0, Y = 0.0;
		GeoToScene(Car.Lat, Car.Lon, X, Z);
		if (GroundFor(TEXT("car"), X, Z, Y))
		{
			FEarthThing Mount;
			Mount.Thing = Car.Thing;
			Mount.Sp = TEXT("car");
			Mount.X = X;
			Mount.Y = Y;
			Mount.Z = Z;
			Mount.Yaw = (-Car.Yaw * UE_DOUBLE_PI) / 180.0;
			Mount.bOutOfPlace = true;
			Mount.bOwnLook = true;
			Mount.Body = Car.Body;
			Mount.Paint = Car.Paint;
			Mounts.Add(Mount);
		}
	}
}

void UEarthCompany::CallTaxi(const FString& Place)
{
	if (UEarthWalkNet* Room = Net.Get())
	{
		Notice(FString::Printf(TEXT("Calling a taxi to take you to %s..."), *Place));
		Room->SendTaxi(Place);
	}
}

void UEarthCompany::OnTaxi(const FEarthTaxi& Taxi, bool bGone)
{
	const bool bMine = Net.IsValid() && Taxi.By == Net->GetMyId();
	if (bGone)
	{
		if (bMine)
		{
			Notice(TEXT("Your taxi gave up waiting and drove off."));
		}
		return;
	}
	Names.Add(Taxi.Thing, Taxi.Name);
	if (bMine)
	{
		Notice(FString::Printf(TEXT("%s the taxi is on its way, to take you to %s. Hop on (E) when it gets here."), *Taxi.Name, *Taxi.Dest));
	}
}

/**
 * Draws each taxi on its way to whoever called it. The server says where it set off from and when,
 * so every game draws it arriving in the same place; once somebody is aboard it is a ridden thing
 * like any other.
 */
void UEarthCompany::TaxiFrame(double T)
{
	UEarthWalkNet* Room = Net.Get();
	if (!Room)
	{
		return;
	}
	constexpr double TaxiPace = 9.0; // metres a second
	const double NowMs = T * 1000.0;
	for (auto It = Room->GetTaxis().CreateIterator(); It; ++It)
	{
		const uint32 Thing = It.Key();
		const FEarthTaxi& Taxi = It.Value();
		if (Hidden.Contains(Thing))
		{
			TaxisUsed.Add(Thing); // somebody is aboard, or it stands where they got off
		}
		if (Taxi.Until <= NowMs)
		{
			It.RemoveCurrent();
			continue;
		}
		if (TaxisUsed.Contains(Thing) || Taxi.Path.Num() == 0)
		{
			continue;
		}
		// Its road in metres, for the world as it is now, and how far along it the clock puts it.
		TArray<FVector2D> Points;
		TArray<double> UpTo;
		Points.Reserve(Taxi.Path.Num());
		for (const FVector2D& Point : Taxi.Path)
		{
			double X = 0.0, Z = 0.0;
			GeoToScene(Point.X, Point.Y, X, Z);
			UpTo.Add(Points.Num() ? UpTo.Last() + std::hypot(X - Points.Last().X, Z - Points.Last().Y) : 0.0);
			Points.Add(FVector2D(X, Z));
		}
		const double Total = UpTo.Last();
		const double Gone = FMath::Min(Total, FMath::Max(0.0, ((NowMs - Taxi.At) / 1000.0) * TaxiPace));
		int32 I = 1;
		while (I < Points.Num() - 1 && UpTo[I] < Gone)
		{
			++I;
		}
		const FVector2D A = Points[FMath::Max(0, I - 1)];
		const FVector2D B = Points[FMath::Min(I, Points.Num() - 1)];
		const double Span = Points.Num() > 1 ? UpTo[FMath::Min(I, Points.Num() - 1)] - UpTo[I - 1] : 0.0;
		const double F = Span > 0.0 ? (Gone - UpTo[I - 1]) / Span : 1.0;
		const double X = A.X + (B.X - A.X) * F, Z = A.Y + (B.Y - A.Y) * F;
		const bool bArrived = Gone >= Total;
		if (bArrived && Taxi.By == Room->GetMyId() && !TaxisTold.Contains(Thing))
		{
			TaxisTold.Add(Thing);
			Notice(FString::Printf(TEXT("%s the taxi is here. Press E beside it to hop on."), *Taxi.Name));
		}
		Hidden.Add(Thing);
		double Y = 0.0;
		if (!GroundFor(TEXT("taxi"), X, Z, Y))
		{
			continue;
		}
		FEarthThing Mount;
		Mount.Thing = Thing;
		Mount.Sp = TEXT("taxi");
		Mount.X = X;
		Mount.Y = Y;
		Mount.Z = Z;
		Mount.Yaw = A.Equals(B) ? 0.0 : std::atan2(-(B.X - A.X), -(B.Y - A.Y));
		Mount.Gait = Gone;
		Mount.bMoving = !bArrived;
		Mount.bOutOfPlace = true;
		Mounts.Add(Mount);
	}
}

// ------------------------------------------------------------------------------------------------
// Going into houses
// ------------------------------------------------------------------------------------------------

/** Which door, if any, is within reach? */
void UEarthCompany::DoorFrame(double Dt)
{
	constexpr double ReachOutM = 2.2; // how near a door you must stand, outside it and inside it
	constexpr double ReachInM = 1.7;
	if ((SinceDoorScan += Dt) < 0.15)
	{
		return;
	}
	SinceDoorScan = 0.0;
	const AEarthWalkCharacter* Me = Player.Get();
	bDoorNear = false;
	double Px = 0.0, Pz = 0.0;
	// Still in the house I went into? Not once I have been taken somewhere else, or wandered off (flying out through the roof).
	if (bInHouse && (!Me || Me->IsWaitingForGround() || !PlayerAt(Px, Pz) || std::hypot(HouseIn.X - Px, HouseIn.Z - Pz) > 45.0 || FMath::Abs(Me->FeetLocation().Z / 100.0 - HouseIn.H) > 12.0))
	{
		bInHouse = false;
	}
	if (Me && World.IsValid() && !Me->IsWaitingForGround() && !Me->GetMount() && !Me->IsCarried() && PlayerAt(Px, Pz))
	{
		const double FeetM = Me->FeetLocation().Z / 100.0;
		TArray<FEarthDoor> DoorsHere;
		World->DoorsNear(Px, Pz, ReachOutM, DoorsHere);
		double BestD = TNumericLimits<double>::Max();
		for (const FEarthDoor& Candidate : DoorsHere)
		{
			const double D = std::hypot(Candidate.X - Px, Candidate.Z - Pz);
			if (D >= BestD || D > ReachOutM)
			{
				continue;
			}
			// The way out, as a compass heading: east and south of the door.
			const double Out = (Candidate.Yaw * UE_DOUBLE_PI) / 180.0;
			const double Side = (Px - Candidate.X) * std::sin(Out) + (Pz - Candidate.Z) * -std::cos(Out);
			const bool bInside = Side < 0.0;
			if (bInside && (D > ReachInM || FMath::Abs(FeetM - Candidate.H) > 1.5))
			{
				continue;
			}
			BestD = D;
			Door = Candidate;
			bDoorInside = bInside;
			bDoorNear = true;
		}
	}
	DoorHint = bDoorNear ? FString(bDoorInside ? TEXT("E: go out") : TEXT("E: go in")) : FString();
	// (When one house in sixteen opened, a line here said so beside each that did. Most open now, since
	// 0.2.25 of the server, so the yellow board over the door is all the telling that is needed.)
}

FString UEarthCompany::NearestHouse() const
{
	double Px = 0.0, Pz = 0.0;
	if (!World.IsValid() || !PlayerAt(Px, Pz))
	{
		return FString();
	}
	TArray<FEarthDoor> Loaded;
	World->DoorsNear(Px, Pz, 3000.0, Loaded);
	const FEarthDoor* Best = nullptr;
	double BestD = TNumericLimits<double>::Max();
	for (const FEarthDoor& Candidate : Loaded)
	{
		const double D = std::hypot(Candidate.X - Px, Candidate.Z - Pz);
		if (D < BestD)
		{
			BestD = D;
			Best = &Candidate;
		}
	}
	if (!Best)
	{
		return FString();
	}
	// East and south of the player, as a compass point.
	static const TCHAR* const Points[] = { TEXT("north"), TEXT("north-east"), TEXT("east"), TEXT("south-east"), TEXT("south"), TEXT("south-west"), TEXT("west"), TEXT("north-west") };
	const double Bearing = std::atan2(Best->X - Px, -(Best->Z - Pz)) * 180.0 / UE_DOUBLE_PI;
	const int32 Point = ((FMath::RoundToInt32(Bearing / 45.0) % 8) + 8) % 8;
	return FString::Printf(TEXT("%d m to the %s"), FMath::RoundToInt32(BestD), Points[Point]);
}

/** The E key at a door. */
void UEarthCompany::UseDoor()
{
	AEarthWalkCharacter* Me = Player.Get();
	AEarthWorld* Earth = World.Get();
	if (!bDoorNear || bDoorBusy || !Me || !Earth)
	{
		return;
	}
	const double Out = (Door.Yaw * UE_DOUBLE_PI) / 180.0;
	const double Ox = std::sin(Out), Oz = -std::cos(Out);
	if (bDoorInside)
	{
		bInHouse = false;
		const double X = Door.X + Ox * 1.4, Z = Door.Z + Oz * 1.4;
		double Ground = Door.H;
		Earth->TerrainHeightAt(X, Z, Ground);
		Me->PlaceFeetAt(SceneToEngine(X, Ground + 0.3, Z));
		return;
	}
	bDoorBusy = true;
	const FEarthDoor Going = Door;
	const TWeakObjectPtr<UEarthCompany> Weak(this);
	Earth->OpenHouse(Going, [Weak, Going, Ox, Oz](bool bOpen, const FString& Why)
	{
		UEarthCompany* Self = Weak.Get();
		AEarthWalkCharacter* Walker = Self ? Self->Player.Get() : nullptr;
		if (!Self)
		{
			return;
		}
		Self->bDoorBusy = false;
		if (!bOpen)
		{
			if (!Why.IsEmpty())
			{
				Self->Notice(Why);
			}
			return;
		}
		if (!Walker)
		{
			return;
		}
		Walker->SetFlying(false);
		Walker->PlaceFeetAt(SceneToEngine(Going.X - Ox * 0.9, Going.H + 0.05, Going.Z - Oz * 0.9));
		Self->bInHouse = true;
		Self->HouseIn = Going;
		if (APlayerController* PC = Cast<APlayerController>(Walker->GetController()))
		{
			FRotator Look = PC->GetControlRotation();
			Look.Yaw = Going.Yaw + 180.0; // facing in
			Look.Pitch = 0.0;
			PC->SetControlRotation(Look);
		}
	});
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
	RaceFrame(T);
	Life->SetOutOfPlace(Hidden, Mounts);
	DoorFrame(Dt);
	const FString& First = RideHint.IsEmpty() ? DoorHint : RideHint;
	Hint = First.IsEmpty() ? TalkHint : TalkHint.IsEmpty() ? First : First + TEXT("      ") + TalkHint;
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
	// -EWDoor: a few seconds after landing, stand at the nearest front door that opens; a moment later, go in.
	static const bool bDoorTest = FParse::Param(FCommandLine::Get(), TEXT("EWDoor"));
	static const FString TaxiPlace = []() { FString Text; FParse::Value(FCommandLine::Get(), TEXT("-EWTaxi="), Text); return Text.Replace(TEXT("_"), TEXT(" ")); }();
	if (Me && Room && Room->IsConnected() && !Me->IsWaitingForGround() && PlayerAt(Px, Pz))
	{
		TestClock += Dt;
		// -EWTreasure stands a treasure chest in front of the player, as when a hunt is won.
		static bool bChestShown = false;
		if (!bChestShown && TestClock > 5.0 && FParse::Param(FCommandLine::Get(), TEXT("EWTreasure")))
		{
			bChestShown = true;
			double Lat = 0.0, Lon = 0.0, Alt = 0.0;
			World->WorldToGeo(Me->GetActorLocation(), Lat, Lon, Alt);
			OnTreasure(Lat, Lon);
		}
		// -EWRace sets a race up along the roads here, and starts it a few seconds later.
		static int32 RaceStep = 0;
		if (FParse::Param(FCommandLine::Get(), TEXT("EWRace")))
		{
			if (RaceStep == 0 && TestClock > 3.0)
			{
				RaceStep = 1;
				KeyRace();
			}
			else if (RaceStep == 1 && TestClock > 8.0)
			{
				RaceStep = 2;
				KeyRace(); // I set it up, so this says go
			}
		}
		// -EWCar calls the player's own car.
		static bool bCarCalled = false;
		if (!bCarCalled && TestClock > 2.0 && FParse::Param(FCommandLine::Get(), TEXT("EWCar")))
		{
			bCarCalled = true;
			CallCar();
		}
		if (!TaxiPlace.IsEmpty() && !bTaxiCalled && TestClock > 2.0)
		{
			bTaxiCalled = true;
			CallTaxi(TaxiPlace);
		}
		if (bDoorTest && DoorTestStep == 0 && TestClock > 4.0)
		{
			DoorTestStep = 1;
			TArray<FEarthDoor> DoorsHere;
			// -EWDoorId=<building> goes to that house, if it is within a kilometre and a half; otherwise the nearest.
			int64 WantedId = 0;
			FParse::Value(FCommandLine::Get(), TEXT("-EWDoorId="), WantedId);
			World->DoorsNear(Px, Pz, WantedId ? 1500.0 : 400.0, DoorsHere);
			const FEarthDoor* Best = nullptr;
			for (const FEarthDoor& Candidate : DoorsHere)
			{
				if (WantedId ? Candidate.Id == WantedId : (!Best || std::hypot(Candidate.X - Px, Candidate.Z - Pz) < std::hypot(Best->X - Px, Best->Z - Pz)))
				{
					Best = &Candidate;
				}
			}
			if (Best)
			{
				const double Out = (Best->Yaw * UE_DOUBLE_PI) / 180.0;
				// -EWDoorLook stands back in the street and looks at the door, for a picture of its sign.
				const bool bLook = FParse::Param(FCommandLine::Get(), TEXT("EWDoorLook"));
				const double Back = bLook ? 8.0 : 1.2;
				const double X = Best->X + std::sin(Out) * Back, Z = Best->Z - std::cos(Out) * Back;
				if (APlayerController* PC = Cast<APlayerController>(Me->GetController()))
				{
					PC->SetControlRotation(FRotator(bLook ? 8.0 : 0.0, Best->Yaw + 180.0, 0.0));
				}
				double Ground = Best->H;
				World->TerrainHeightAt(X, Z, Ground);
				Me->PlaceFeetAt(SceneToEngine(X, Ground + 0.3, Z));
				SinceDoorScan = 1.0;
				UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: standing at the door of building %lld, one of %d doors near"), Best->Id, DoorsHere.Num());
			}
			else
			{
				UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: no front door that opens near here"));
			}
		}
		else if (bDoorTest && DoorTestStep == 1 && TestClock > 6.0)
		{
			DoorTestStep = 2;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: at the door: near %d, inside %d, hint \"%s\""), bDoorNear ? 1 : 0, bDoorInside ? 1 : 0, *DoorHint);
			if (!FParse::Param(FCommandLine::Get(), TEXT("EWDoorLook")))
			{
				UseDoor();
			}
		}
		else if (bDoorTest && DoorTestStep == 2 && TestClock > 9.0)
		{
			DoorTestStep = 3;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: after the door: near %d, inside %d, hint \"%s\", feet at %.2f m"), bDoorNear ? 1 : 0, bDoorInside ? 1 : 0, *DoorHint, Me->FeetLocation().Z / 100.0);
			// -EWDoorTurn then looks back at the door from inside and a little down, which puts the camera of
			// the views from behind out in the middle of the room and high, where only the ceiling can stop it.
			APlayerController* PC = Cast<APlayerController>(Me->GetController());
			if (PC && FParse::Param(FCommandLine::Get(), TEXT("EWDoorTurn")))
			{
				FRotator Facing = PC->GetControlRotation();
				Facing.Yaw += 180.0;
				Facing.Pitch = -25.0;
				PC->SetControlRotation(Facing);
			}
		}
		else if (bDoorTest && DoorTestStep == 3 && TestClock > 16.0)
		{
			// And out again, to see the way back works.
			DoorTestStep = 4;
			if (FParse::Param(FCommandLine::Get(), TEXT("EWDoorOut")))
			{
				UseDoor();
			}
		}
		else if (bDoorTest && DoorTestStep == 4 && TestClock > 18.0)
		{
			DoorTestStep = 5;
			const APlayerController* PC = Cast<APlayerController>(Me->GetController());
			const double CameraM = PC && PC->PlayerCameraManager ? PC->PlayerCameraManager->GetCameraLocation().Z / 100.0 : 0.0;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: company: later at the door: near %d, inside %d, hint \"%s\", feet at %.2f m, camera at %.2f m"), bDoorNear ? 1 : 0, bDoorInside ? 1 : 0, *DoorHint, Me->FeetLocation().Z / 100.0, CameraM);
		}
	}
	if ((RideKind.IsEmpty() && TalkKind.IsEmpty()) || TestStep > 3 || !Me || !Room || !Life || !Room->IsConnected() || Me->IsWaitingForGround() || !PlayerAt(Px, Pz))
	{
		return;
	}
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
	FEarthThing Waiting;
	if (TestStep == 0 && RideKind == TEXT("taxi") && TestClock < 150.0 && !(Nearest(RideKind, Waiting) && !Waiting.bMoving))
	{
		return; // the taxi has not pulled up yet
	}
	if (TestStep == 0 && RideKind == TEXT("taxi"))
	{
		TestClock = 4.5; // the rest of the timetable starts when the taxi is here
	}
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
