#include "EarthLife.h"

#include "EarthSounds.h"
#include "EarthWorld.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "UObject/ConstructorHelpers.h"

#include <cmath>

namespace
{
	constexpr int32 NumShapes = static_cast<int32>(EEarthShape::Count);
	static_assert(NumShapes == 4, "AEarthLife keeps four instanced meshes, one per shape");

	// Animals. Near the player they are whole and alive to who is about; further off they are simpler
	// figures that still walk where the clock says. (The browser draws 110 out to 220 m.)
	constexpr double ShowM = 400.0; // homes further off than this are not drawn
	constexpr double FullM = 120.0;
	constexpr int32 MaxFull = 60;
	constexpr int32 MaxStandIns = 200;
	constexpr int32 MaxBirds = 60;
	constexpr double HearM = 70.0;
	constexpr uint32 SaltCoat = 0x434f4154;
	constexpr uint32 SaltVoice = 0x564f4943;

	// Vehicles: the same numbers as traffic.js, seen a little further.
	constexpr double ShowCarsM = 300.0;
	constexpr int32 MaxParked = 40;
	constexpr int32 MaxTrips = 14;
	constexpr uint32 SaltPaint = 0x5041494e;
	constexpr double TrainShowM = 500.0;
	constexpr int32 Carriages = 4;
	constexpr double CarriageM = 13.6;
	constexpr double CouplingM = 0.7;
	constexpr double TrainM = Carriages * CarriageM + (Carriages - 1) * CouplingM;
	// The server lays roads and rails a little above the ground they run over (server/src/chunk.ts).
	constexpr double RoadLiftM = 0.18;
	constexpr double RailLiftM = 0.1;

	constexpr double Pi = 3.141592653589793;

	double Ease(double Rate, double Dt) { return 1.0 - std::exp(-Rate * Dt); }

	/** The shortest way round from one angle to another, in radians. */
	double TurnTo(double From, double To)
	{
		double D = std::fmod(To - From, Pi * 2.0);
		if (D > Pi)
		{
			D -= Pi * 2.0;
		}
		if (D < -Pi)
		{
			D += Pi * 2.0;
		}
		return D;
	}

	/** Metres (x east, y up, z south from the world's origin) in engine units. */
	FVector Engine(double X, double Y, double Z) { return FVector(-Z * 100.0, X * 100.0, Y * 100.0); }

	bool Number(const FJsonObject& Json, const TCHAR* Field, double& Out)
	{
		return Json.TryGetNumberField(Field, Out) && FMath::IsFinite(Out);
	}

	/** The path of a trip or a train's run, from chunk fractions to metres from the world's origin. */
	bool ReadPath(const FJsonObject& Json, double Ox, double Oz, double S, TArray<double>& Out)
	{
		const TArray<TSharedPtr<FJsonValue>>* Points = nullptr;
		if (!Json.TryGetArrayField(TEXT("pts"), Points) || Points->Num() < 6)
		{
			return false;
		}
		Out.Reserve(Points->Num());
		for (int32 i = 0; i < Points->Num(); ++i)
		{
			double Value = 0.0;
			if (!(*Points)[i].IsValid() || !(*Points)[i]->TryGetNumber(Value) || !FMath::IsFinite(Value))
			{
				return false;
			}
			Out.Add(i % 3 == 0 ? Ox + Value * S : i % 3 == 1 ? Oz + Value * S : Value);
		}
		return true;
	}
}

AEarthLife::AEarthLife()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cone(TEXT("/Engine/BasicShapes/Cone.Cone"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Plain(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	ShapeMeshes[static_cast<int32>(EEarthShape::Sphere)] = Sphere.Object;
	ShapeMeshes[static_cast<int32>(EEarthShape::Cyl)] = Cylinder.Object;
	ShapeMeshes[static_cast<int32>(EEarthShape::Cone)] = Cone.Object;
	ShapeMeshes[static_cast<int32>(EEarthShape::Box)] = Cube.Object;
	// The painted material that takes each shape's own colour; plain white until game\Tools\build-assets.cmd has made it.
	FigureMaterial = LoadObject<UMaterialInterface>(nullptr, TEXT("/Game/EarthWalk/Materials/M_EarthFigure.M_EarthFigure"));
	if (!FigureMaterial)
	{
		FigureMaterial = Plain.Object;
	}
	for (int32 i = 0; i < NumShapes; ++i)
	{
		UInstancedStaticMeshComponent* Shape = CreateDefaultSubobject<UInstancedStaticMeshComponent>(*FString::Printf(TEXT("Shape%d"), i));
		Shape->SetStaticMesh(ShapeMeshes[i]);
		Shape->SetMaterial(0, FigureMaterial);
		Shape->SetMobility(EComponentMobility::Movable);
		Shape->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		Shape->SetCanEverAffectNavigation(false);
		Shape->SetNumCustomDataFloats(3);
		Shape->SetupAttachment(RootComponent);
		Shapes[i] = Shape;
	}
	Sounds = CreateDefaultSubobject<UEarthSounds>(TEXT("Sounds"));
}

AEarthLife::FLooks AEarthLife::LooksOf(uint32 Id)
{
	// One car in six is a van. Its paint and size come from its identity, so they are the same for everyone.
	FLooks Looks;
	Looks.Rig = EarthRigs::Find(EarthLife::Hash32(Id, SaltPaint) % 6 == 0 ? TEXT("van") : TEXT("car"));
	Looks.Coat = Looks.Rig ? EarthLife::Hash32(Id, SaltPaint + 1) % Looks.Rig->Coats.Num() : 0;
	Looks.Size = 0.94 + 0.12 * EarthLife::Unit(Id, SaltPaint + 2);
	return Looks;
}

void AEarthLife::AddChunk(FIntPoint Key, const TArray<TSharedPtr<FJsonValue>>& Items, double OriginX, double OriginY, double TileM)
{
	const double S = TileM;
	const double Ox = (Key.X - OriginX) * S;
	const double Oz = (Key.Y - OriginY) * S;
	FChunk Chunk;
	for (const TSharedPtr<FJsonValue>& Value : Items)
	{
		const TSharedPtr<FJsonObject>* Item = nullptr;
		if (!Value.IsValid() || !Value->TryGetObject(Item) || !Item || !Item->IsValid())
		{
			continue;
		}
		const FJsonObject& Json = **Item;
		FString Kind;
		double Id = 0.0, U = 0.0, V = 0.0;
		if (!Json.TryGetStringField(TEXT("kind"), Kind) || !Number(Json, TEXT("id"), Id) || !Number(Json, TEXT("u"), U) || !Number(Json, TEXT("v"), V))
		{
			continue; // trees, letterboxes and signs have no identity: AEarthChunkLabels draws those
		}
		const uint32 Identity = static_cast<uint32>(static_cast<int64>(Id));

		if (Kind == TEXT("home"))
		{
			FString Animal;
			double N = 0.0, R = 0.0, H = 0.0;
			if (!Json.TryGetStringField(TEXT("sp"), Animal) || !Number(Json, TEXT("n"), N) || !Number(Json, TEXT("r"), R) || !Number(Json, TEXT("h"), H))
			{
				continue;
			}
			FHerd Herd;
			Herd.Home.Species = EarthLife::FindSpecies(Animal);
			Herd.Rig = EarthRigs::Find(Animal);
			if (!Herd.Home.Species || !Herd.Rig)
			{
				continue; // an animal this game does not know yet
			}
			Herd.Home.Id = Identity;
			Herd.Home.N = FMath::Clamp(FMath::RoundToInt32(N), 1, 12);
			Herd.Home.R = FMath::Clamp(R, 1.0, 80.0);
			Herd.H = H;
			Herd.X = Ox + U * S;
			Herd.Z = Oz + V * S;
			Chunk.Herds.Add(Herd);
		}
		else if (Kind == TEXT("car"))
		{
			FParked Car;
			if (!Number(Json, TEXT("yaw"), Car.Yaw))
			{
				continue;
			}
			Car.Id = Identity;
			Car.X = Ox + U * S;
			Car.Z = Oz + V * S;
			Car.Looks = LooksOf(Identity);
			if (Car.Looks.Rig)
			{
				Chunk.Parked.Add(Car);
			}
		}
		else if (Kind == TEXT("route"))
		{
			FCar Car;
			double Left = 0.0;
			if (!Number(Json, TEXT("w"), Car.Trip.W) || !Number(Json, TEXT("da"), Car.Trip.Da) || !Number(Json, TEXT("db"), Car.Trip.Db)
				|| !ReadPath(Json, Ox, Oz, S, Car.Trip.Path))
			{
				continue;
			}
			bool bLeft = false;
			Car.Trip.bLeft = (Json.TryGetNumberField(TEXT("left"), Left) && Left != 0.0) || (Json.TryGetBoolField(TEXT("left"), bLeft) && bLeft);
			Car.Trip.Id = Identity;
			Car.Trip.W = FMath::Clamp(Car.Trip.W, 2.5, 40.0);
			Car.Trip.Da = FMath::Max(1.0, Car.Trip.Da);
			Car.Trip.Db = FMath::Max(1.0, Car.Trip.Db);
			EarthLife::Prepare(Car.Trip);
			Car.Looks = LooksOf(Identity);
			if (Car.Trip.Time > 0.0 && Car.Looks.Rig)
			{
				Chunk.Trips.Add(MoveTemp(Car));
			}
		}
		else if (Kind == TEXT("train"))
		{
			// A train comes with every chunk on its run. Its path is measured from the chunk that sent it.
			FTrain Train;
			if (!Number(Json, TEXT("da"), Train.Trip.Da) || !Number(Json, TEXT("db"), Train.Trip.Db) || !ReadPath(Json, Ox, Oz, S, Train.Trip.Path))
			{
				continue;
			}
			Train.Trip.Id = Identity;
			Train.Trip.Da = FMath::Max(1.0, Train.Trip.Da);
			Train.Trip.Db = FMath::Max(1.0, Train.Trip.Db);
			EarthLife::Prepare(Train.Trip);
			Train.Rig = EarthRigs::Find(TEXT("railcar"));
			if (Train.Rig && Train.Trip.Time > 0.0 && Train.Trip.Length > TrainM + 30.0)
			{
				Train.Coat = EarthLife::Hash32(Identity, SaltPaint) % Train.Rig->Coats.Num();
				Chunk.Trains.Add(MoveTemp(Train));
			}
		}
	}
	UE_LOG(LogTemp, Log, TEXT("EarthWalk: life: chunk %d/%d brought %d homes, %d parked cars, %d trips, %d trains"),
		Key.X, Key.Y, Chunk.Herds.Num(), Chunk.Parked.Num(), Chunk.Trips.Num(), Chunk.Trains.Num());
	Chunks.Add(Key, MoveTemp(Chunk));
	bDirty = true;
}

void AEarthLife::RemoveChunk(FIntPoint Key)
{
	if (Chunks.Remove(Key) > 0)
	{
		// The lists hold pointers into the chunk that has just gone.
		Herds.Reset();
		Parked.Reset();
		Trips.Reset();
		Trains.Reset();
		bDirty = true;
	}
}

void AEarthLife::Clear()
{
	Chunks.Reset();
	Herds.Reset();
	Parked.Reset();
	Trips.Reset();
	Trains.Reset();
	States.Reset();
	CarStates.Reset();
	TrainStates.Reset();
	for (int32 i = 0; i < NumShapes; ++i)
	{
		if (Shapes[i])
		{
			Shapes[i]->ClearInstances();
		}
	}
	Shown = 0;
	bDirty = true;
}

void AEarthLife::HomeCirclesIn(const FBox2D& Area, TArray<FVector>& OutCentreAndRadius) const
{
	for (const TPair<FIntPoint, FChunk>& Pair : Chunks)
	{
		for (const FHerd& Herd : Pair.Value.Herds)
		{
			const FVector2D Centre(-Herd.Z * 100.0, Herd.X * 100.0);
			const double Reach = (Herd.Home.R + 0.6) * 100.0;
			if (!Herd.Rig->bFly && !Herd.Rig->bSwim && Centre.X > Area.Min.X - Reach && Centre.X < Area.Max.X + Reach && Centre.Y > Area.Min.Y - Reach && Centre.Y < Area.Max.Y + Reach)
			{
				OutCentreAndRadius.Add(FVector(Centre.X, Centre.Y, Reach));
			}
		}
	}
}

void AEarthLife::HomeCircles(FIntPoint Key, TArray<FVector>& OutCentreAndRadius) const
{
	if (const FChunk* Chunk = Chunks.Find(Key))
	{
		for (const FHerd& Herd : Chunk->Herds)
		{
			if (!Herd.Rig->bFly && !Herd.Rig->bSwim)
			{
				OutCentreAndRadius.Add(FVector(-Herd.Z * 100.0, Herd.X * 100.0, (Herd.Home.R + 0.6) * 100.0));
			}
		}
	}
}

/** A couple of times a second: which homes and cars are near enough to matter, nearest first. */
void AEarthLife::Sync(const FVector2D& Me)
{
	Herds.Reset();
	Parked.Reset();
	Trips.Reset();
	Trains.Reset();
	TSet<uint32> TrainsSeen; // one of each, whichever chunk it came with
	for (TPair<FIntPoint, FChunk>& Pair : Chunks)
	{
		for (FHerd& Herd : Pair.Value.Herds)
		{
			Herd.D = FVector2D::Distance(FVector2D(Herd.X, Herd.Z), Me);
			if (Herd.D < ShowM + Herd.Home.R)
			{
				Herds.Add(&Herd);
			}
		}
		for (FParked& Car : Pair.Value.Parked)
		{
			Car.D = FVector2D::Distance(FVector2D(Car.X, Car.Z), Me);
			if (Car.D < ShowCarsM)
			{
				Parked.Add(&Car);
			}
		}
		for (const FCar& Car : Pair.Value.Trips)
		{
			// A trip is never longer than 420 m, so a car that starts further off than that cannot be near.
			if (FVector2D::Distance(FVector2D(Car.Trip.Path[0], Car.Trip.Path[1]), Me) < ShowCarsM + 450.0)
			{
				Trips.Add(&Car);
			}
		}
		for (const FTrain& Train : Pair.Value.Trains)
		{
			bool bAlready = false;
			TrainsSeen.Add(Train.Trip.Id, &bAlready);
			if (!bAlready)
			{
				Trains.Add(&Train);
			}
		}
	}
	Herds.Sort([](const FHerd& A, const FHerd& B) { return A.D < B.D; });
	Parked.Sort([](const FParked& A, const FParked& B) { return A.D < B.D; });
	if (Parked.Num() > MaxParked)
	{
		Parked.SetNum(MaxParked);
	}
	// Far-off animals are forgotten; they are calm again by the time we return.
	if (States.Num() > 600)
	{
		States.Reset();
	}
	if (CarStates.Num() > 300)
	{
		CarStates.Reset();
	}
	if (TrainStates.Num() > 60)
	{
		TrainStates.Reset();
	}
}

void AEarthLife::Update(const AEarthWorld* World, float DeltaSeconds, double SharedTime, const TArray<FVector>& PlayersCm, const FVector& Ears)
{
	if (!World || PlayersCm.Num() == 0)
	{
		return;
	}
	if (Sounds && !Sounds->HasAnyFlags(RF_ClassDefaultObject))
	{
		Sounds->Setup(this);
		Sounds->Tick();
	}
	const double Began = FPlatformTime::Seconds();
	EarsNow = Ears;
	const double Dt = FMath::Min(0.25, static_cast<double>(DeltaSeconds));
	const double T = SharedTime;

	// Everyone, in metres: x east and y south of the world's origin.
	TArray<FVector2D> Players;
	Players.Reserve(PlayersCm.Num());
	for (const FVector& Player : PlayersCm)
	{
		Players.Add(FVector2D(Player.Y / 100.0, -Player.X / 100.0));
	}

	SyncTimer -= DeltaSeconds;
	if (bDirty || SyncTimer <= 0.f)
	{
		Sync(Players[0]);
		SyncTimer = 0.5f;
		bDirty = false;
	}

	for (int32 i = 0; i < NumShapes; ++i)
	{
		Transforms[i].Reset();
		Colours[i].Reset();
	}

	const int64 Slot = static_cast<int64>(std::floor(T / EarthLife::CallSlot));
	int32 Full = 0, StandIns = 0, Birds = 0;
	for (const FHerd* Herd : Herds)
	{
		for (int32 K = 0; K < Herd->Home.N; ++K)
		{
			if (Herd->Rig->bFly ? Birds >= MaxBirds : (Full >= MaxFull && StandIns >= MaxStandIns))
			{
				break;
			}
			switch (DrawAnimal(World, *Herd, K, Dt, T, Slot, Players, Full < MaxFull, StandIns < MaxStandIns))
			{
			case EDrawn::Whole: ++Full; break;
			case EDrawn::Simple: ++StandIns; break;
			case EDrawn::Flying: ++Birds; break;
			default: break;
			}
		}
	}
	const int32 Animals = Full + StandIns + Birds;
	DrawTraffic(World, Dt, T, Players, PlayersCm[0].Z / 100.0);
	Flush();
	Shown = Animals;
	LastTime = T;

	const double Now = FPlatformTime::Seconds();
	double WhereTime = 0.0;
	if (WhereAt >= 0.0 && FParse::Value(FCommandLine::Get(), TEXT("-EWLifeWhere="), WhereTime))
	{
		if (WhereAt == 0.0 && (Herds.Num() > 0 || Trips.Num() > 0 || Trains.Num() > 0))
		{
			WhereAt = Now + 6.0; // give the chunks round about a moment to arrive too
		}
		else if (WhereAt > 0.0 && Now > WhereAt)
		{
			WhereAt = -1.0;
			LogWhere(World, WhereTime);
		}
	}
	WorkSeconds += Now - Began;
	++WorkFrames;
	if (Now > LogAt)
	{
		LogAt = Now + 10.0;
		UE_LOG(LogTemp, Log, TEXT("EarthWalk: life: %d animals near (%d whole, %d simple, %d flying), %d parked cars, %d trips, %d trains known; %d calls played; %.2f ms a frame over %d frames"),
			Animals, Full, StandIns, Birds, Parked.Num(), Trips.Num(), Trains.Num(), Sounds ? Sounds->NumPlayed() : 0, WorkSeconds * 1000.0 / WorkFrames, WorkFrames);
		WorkSeconds = 0.0;
		WorkFrames = 0;
	}
}

void AEarthLife::LogWhere(const AEarthWorld* World, double T) const
{
	const auto Geo = [World](double X, double Z, double& Lat, double& Lon)
	{
		double Alt;
		World->WorldToGeo(Engine(X, 0.0, Z), Lat, Lon, Alt);
	};
	double Lat, Lon;
	int32 Lines = 0;
	for (const FHerd* Herd : Herds)
	{
		for (int32 K = 0; K < Herd->Home.N && Lines < 400; ++K, ++Lines)
		{
			const EarthLife::FCreature C = EarthLife::CreatureAt(Herd->Home, K, T);
			Geo(Herd->X + C.X, Herd->Z + C.Y, Lat, Lon);
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: where: animal %u %s %.8f %.8f %.3f"), C.Id, *Herd->Rig->Name, Lat, Lon, C.Alt);
		}
	}
	for (const FCar* Car : Trips)
	{
		const EarthLife::FTripPose Pose = EarthLife::TripPose(Car->Trip, T);
		Geo(Pose.X, Pose.Y, Lat, Lon);
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: where: car %u %s %.8f %.8f %.3f"), Car->Trip.Id, *Car->Looks.Rig->Name, Lat, Lon, Pose.Yaw);
	}
	for (const FTrain* Train : Trains)
	{
		const EarthLife::FTrainPose Pose = EarthLife::TrainPose(Train->Trip, T);
		const FVector2D At = EarthLife::PointAt(Train->Trip, TrainM / 2.0 + (Pose.Along * (Train->Trip.Length - TrainM)) / Train->Trip.Length);
		Geo(At.X, At.Y, Lat, Lon);
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: where: train %u railcar %.8f %.8f %.3f"), Train->Trip.Id, Lat, Lon, Pose.Along);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: where: done at shared time %.3f"), T);
}

/** Each animal has its own voice: a little higher or lower than its neighbours. */
void AEarthLife::Call(const TCHAR* Kind, uint32 Id, double X, double Y, double Z)
{
	if (Sounds && Kind)
	{
		Sounds->Play(Kind, Engine(X, Y + 0.8, Z), 0.86 + 0.28 * EarthLife::Unit(Id, SaltVoice), EarsNow);
	}
}

AEarthLife::EDrawn AEarthLife::DrawAnimal(const AEarthWorld* World, const FHerd& Herd, int32 K, double Dt, double T, int64 Slot, const TArray<FVector2D>& Players, bool bMayBeWhole, bool bMayBeSimple)
{
	const FEarthRig& Rig = *Herd.Rig;
	const EarthLife::FHome& Home = Herd.Home;
	// A machine that stopped for somebody is running late; it makes the time up afterwards.
	const FState* Late = Rig.Yields > 0.0 ? States.Find(EarthLife::MemberId(Home.Id, K)) : nullptr;
	const EarthLife::FCreature C = EarthLife::CreatureAt(Home, K, T - (Late ? Late->Lag : 0.0));
	const double Sx = Herd.X + C.X;
	const double Sz = Herd.Z + C.Y;
	const double Beat = (C.Id % 628) / 100.0; // so no two animals nod, wag or flap in step
	const double Size = 0.9 + 0.2 * EarthLife::Unit(C.Id, SaltCoat + 1);
	const int32 Coat = EarthLife::Hash32(Rig.bFlock ? Home.Id : C.Id, SaltCoat) % Rig.Coats.Num();
	const FLinearColor& CoatA = Rig.PaletteA[Coat];
	const FLinearColor& CoatB = Rig.PaletteB[Coat];

	// ---- its voice: at moments everyone agrees on
	if (Rig.Voice && Herd.D < HearM + (Rig.bFly ? Home.R : 0.0))
	{
		double At = 0.0;
		if (EarthLife::CallTime(C.Id, *Home.Species, Slot, At) && At > LastTime && At <= T && T - LastTime < 1.0)
		{
			Call(Rig.Voice, C.Id, Sx, Herd.H + C.Alt, Sz);
		}
	}

	FBase Base;
	FPose Pose;
	Pose.Beat = Beat;

	// ---- a flock overhead takes no notice of anyone
	if (Rig.bFly)
	{
		Base.Position = Engine(Sx, Herd.H + C.Alt, Sz);
		Base.Rotation = EarthRigs::Turned(0.0, (-C.Yaw * Pi) / 180.0, 0.0);
		Base.Size = Size;
		Pose.Flap = Rig.WingAir.X + Rig.WingAir.Y * std::sin(T * Rig.WingRate + Beat);
		Put(Rig, CoatA, CoatB, Base, Pose, T);
		return EDrawn::Flying;
	}

	// ---- far off: a simpler figure, walking where the clock says and minding nobody
	const double FromMe = FVector2D::Distance(FVector2D(Sx, Sz), Players[0]);
	if (!bMayBeWhole || FromMe > FullM)
	{
		double Ground = 0.0;
		if (!bMayBeSimple || FromMe > ShowM || !World->TerrainHeightAt(Sx, Sz, Ground))
		{
			return EDrawn::Unseen;
		}
		Base.Position = Engine(Sx, Ground - (Rig.bSwim ? Rig.Swim * Size : 0.0), Sz);
		Base.Rotation = EarthRigs::Turned(0.0, (-C.Yaw * Pi) / 180.0, Rig.Heel);
		Base.Size = Size;
		Pose.bStandIn = true;
		Pose.Swing = C.bMoving ? std::sin((C.Gait / Rig.Stride) * Pi * 2.0) * 0.55 : 0.0;
		Pose.bTogether = Rig.Hop > 0.0;
		Put(Rig, CoatA, CoatB, Base, Pose, T);
		return EDrawn::Simple;
	}

	FState* St = States.Find(C.Id);
	if (!St)
	{
		St = &States.Add(C.Id);
		St->Yaw = (-C.Yaw * Pi) / 180.0;
	}

	// ---- who is near? Measured from where the animal should be, so stepping aside does not make it dither.
	const FVector2D* Near = nullptr;
	double NearD = TNumericLimits<double>::Max();
	for (const FVector2D& P : Players)
	{
		const double D = std::hypot(P.X - Sx, P.Y - Sz);
		if (D < NearD)
		{
			NearD = D;
			Near = &P;
		}
	}
	const bool bStartled = Rig.Flee > 0.0 && NearD < Rig.Flee;
	const bool bGreeting = Rig.Curious > 0.0 && NearD < Rig.Alert;
	double WantX = 0.0;
	double WantZ = 0.0;
	if (bStartled)
	{
		// Step aside, straight away from whoever it is.
		const double Away = FMath::Min(3.0, Rig.Flee - NearD + 0.8) / FMath::Max(NearD, 0.01);
		WantX = (Sx - Near->X) * Away;
		WantZ = (Sz - Near->Y) * Away;
	}
	else if (bGreeting)
	{
		// Trot over to say hello, stopping a little short.
		const double Toward = FMath::Min(Rig.Curious, FMath::Max(0.0, NearD - 1.2)) / FMath::Max(NearD, 0.01);
		WantX = (Near->X - Sx) * Toward;
		WantZ = (Near->Y - Sz) * Toward;
	}
	const double Pull = Ease(bStartled ? 5.0 : bGreeting ? 2.0 : 0.8, Dt);
	const double StepX = (WantX - St->Ox) * Pull;
	const double StepZ = (WantZ - St->Oz) * Pull;
	St->Ox += StepX;
	St->Oz += StepZ;
	const double Aside = std::hypot(StepX, StepZ);
	const bool bHurrying = Dt > 0.0 && Aside / Dt > 0.25;
	St->Up += ((bStartled && Rig.TakesOff > 0.0 ? Rig.TakesOff : 0.0) - St->Up) * Ease(bStartled ? 3.0 : 0.9, Dt);
	const bool bAirborne = St->Up > 0.15;
	if (((bStartled && !St->bStartled) || (bGreeting && !St->bGreeted)) && Rig.Alarm && T > St->QuietUntil)
	{
		St->QuietUntil = T + 5.0;
		double Ground = 0.0;
		World->TerrainHeightAt(Sx, Sz, Ground);
		Call(Rig.Alarm, C.Id, Sx, Ground, Sz);
	}
	St->bStartled = bStartled;
	St->bGreeted = bGreeting;

	const double X = Sx + St->Ox;
	const double Z = Sz + St->Oz;
	double Ground = 0.0;
	if (!World->TerrainHeightAt(X, Z, Ground))
	{
		return EDrawn::Unseen;
	}

	if (Rig.Yields > 0.0)
	{
		// A tractor stops for anyone in front of it, and toots.
		const double A = (C.Yaw * Pi) / 180.0;
		bool bBlocked = false;
		for (const FVector2D& P : Players)
		{
			const double Ahead = (P.X - X) * std::sin(A) - (P.Y - Z) * std::cos(A);
			const double Off = FMath::Abs((P.X - X) * std::cos(A) + (P.Y - Z) * std::sin(A));
			if (Ahead > 0.5 && Ahead < Rig.Yields && Off < 1.8)
			{
				bBlocked = true;
				break;
			}
		}
		if (bBlocked)
		{
			St->Lag = FMath::Min(90.0, St->Lag + Dt);
			if (Rig.Alarm && T > St->TootAt)
			{
				St->TootAt = T + 4.0;
				Call(Rig.Alarm, C.Id, X, Ground, Z);
			}
		}
		else if (St->Lag > 0.0)
		{
			St->Lag = FMath::Max(0.0, St->Lag - Dt * 0.3);
		}
	}

	// ---- pose
	const bool bMoving = C.bMoving || bHurrying;
	St->Walk += ((bMoving ? 1.0 : 0.0) - St->Walk) * Ease(8.0, Dt);
	St->Gait += Aside;
	const double Facing = bGreeting && !bHurrying && !C.bMoving ? std::atan2(-(Near->X - X), -(Near->Y - Z))
		: bHurrying ? std::atan2(-StepX, -StepZ)
		: (-C.Yaw * Pi) / 180.0;
	St->Yaw += TurnTo(St->Yaw, Facing) * Ease(bHurrying ? 10.0 : 4.0, Dt);
	const bool bAlert = Rig.Alert > 0.0 && NearD < Rig.Alert && !bMoving;
	double Pitch = 0.0;
	double Look = 0.0;
	if (bAlert)
	{
		// Head up, turned to the visitor as far as a neck goes.
		const double Dx = Near->X - X;
		const double Dz = Near->Y - Z;
		const double Lx = Dx * std::cos(St->Yaw) - Dz * std::sin(St->Yaw);
		const double Lz = Dx * std::sin(St->Yaw) + Dz * std::cos(St->Yaw);
		Look = FMath::Min(1.1, FMath::Max(-1.1, std::atan2(-Lx, -Lz)));
	}
	else if (C.bGraze && !bMoving && !bAirborne)
	{
		const double Tick = T * (Rig.bPeck ? 5.0 : 4.0) + Beat;
		Pitch = Rig.bPeck ? -Rig.Graze * std::pow(FMath::Max(0.0, std::sin(Tick)), 3.0) : -Rig.Graze + std::sin(Tick) * 0.06;
	}
	St->Head += (Pitch - St->Head) * Ease(Rig.bPeck ? 14.0 : 2.5, Dt);
	St->Look += (Look - St->Look) * Ease(4.0, Dt);
	const double Stride = ((C.Gait + St->Gait) / Rig.Stride) * Pi * 2.0;
	const double Swing = bAirborne ? 0.0 : std::sin(Stride) * 0.55 * St->Walk;
	const double Lift = Rig.Hop > 0.0 ? FMath::Abs(std::sin(Stride / 2.0)) * Rig.Hop * St->Walk : FMath::Abs(std::sin(Stride)) * 0.03 * St->Walk;
	const double Bob = Rig.bSwim ? std::sin(T * 1.7 + Beat) * 0.012 - Rig.Swim : 0.0;
	const double Roll = Rig.Waddle > 0.0 ? std::sin(Stride) * Rig.Waddle * St->Walk : Rig.Heel;
	double Flap = 0.0;
	if (Rig.bWing)
	{
		const FVector2D Wing = bAirborne ? Rig.WingAir : bStartled && Rig.bWingStartled ? Rig.WingStartled : bMoving ? Rig.WingWalk : FVector2D::ZeroVector;
		Flap = Wing.X + Wing.Y * std::sin(Rig.WingRate != 0.0 ? T * Rig.WingRate + Beat : Stride);
	}

	Base.Position = Engine(X, Ground + St->Up + (Lift + Bob) * Size, Z);
	Base.Rotation = EarthRigs::Turned(0.0, St->Yaw, Roll);
	Base.Size = Size;
	Pose.State = St;
	Pose.Flap = Flap;
	Pose.Swing = Swing;
	Pose.Wag = bGreeting ? 4.0 : 1.0;
	Pose.bTogether = Rig.Hop > 0.0;
	Put(Rig, CoatA, CoatB, Base, Pose, T);
	return EDrawn::Whole;
}

void AEarthLife::DrawTraffic(const AEarthWorld* World, double Dt, double T, const TArray<FVector2D>& Players, double MyHeight)
{
	const FPose AtRest;
	const FVector2D Me = Players[0];
	for (const FParked* Car : Parked)
	{
		double Y = 0.0;
		if (!World->TerrainHeightAt(Car->X, Car->Z, Y))
		{
			continue;
		}
		const FEarthRig& Rig = *Car->Looks.Rig;
		FBase Base;
		Base.Position = Engine(Car->X, Y + RoadLiftM, Car->Z);
		Base.Rotation = EarthRigs::Turned(0.0, (-Car->Yaw * Pi) / 180.0, 0.0);
		Base.Size = Car->Looks.Size;
		Put(Rig, Rig.PaletteA[Car->Looks.Coat], Rig.PaletteB[Car->Looks.Coat], Base, AtRest, T);
	}

	// Where every car on a trip is now; the nearest are drawn, and of those on the move only so many.
	struct FNear
	{
		const FCar* Car;
		EarthLife::FTripPose Pose;
		double D;
	};
	TArray<FNear> Near;
	for (const FCar* Car : Trips)
	{
		const FCarState& St = CarStates.FindOrAdd(Car->Trip.Id);
		const EarthLife::FTripPose Pose = EarthLife::TripPose(Car->Trip, T - St.Lag);
		const double D = std::hypot(Pose.X - Me.X, Pose.Y - Me.Y);
		if (D <= ShowCarsM)
		{
			Near.Add({ Car, Pose, D });
		}
	}
	Near.Sort([](const FNear& A, const FNear& B) { return A.D < B.D; });
	int32 Moving = 0;
	for (const FNear& Entry : Near)
	{
		const EarthLife::FTripPose& Pose = Entry.Pose;
		if (Pose.bMoving && ++Moving > MaxTrips)
		{
			continue;
		}
		const uint32 Id = Entry.Car->Trip.Id;
		FCarState& St = CarStates.FindChecked(Id);
		const double Want = (-Pose.Yaw * Pi) / 180.0;
		const double Fx = std::sin(-Want); // the way it faces: x east, z south
		const double Fz = -std::cos(Want);

		// ---- is somebody in the way? Then wait, toot, and make up the time afterwards.
		bool bBlocked = false;
		if (Pose.bMoving)
		{
			for (const FVector2D& P : Players)
			{
				const double Ahead = (P.X - Pose.X) * Fx + (P.Y - Pose.Y) * Fz;
				const double Off = FMath::Abs((P.X - Pose.X) * Fz - (P.Y - Pose.Y) * Fx);
				if (Ahead > 1.0 && Ahead < 8.0 && Off < 1.6)
				{
					bBlocked = true;
					break;
				}
			}
		}
		double Y = 0.0;
		const bool bGround = World->TerrainHeightAt(Pose.X, Pose.Y, Y);
		if (bBlocked)
		{
			St.Lag = FMath::Min(90.0, St.Lag + Dt); // after a minute and a half it gives up waiting and drives on
			if (T > St.TootAt)
			{
				St.TootAt = T + 4.0;
				if (Sounds)
				{
					Sounds->Play(TEXT("toot"), Engine(Pose.X, (bGround ? Y : 0.0) + 1.0, Pose.Y), 0.9 + 0.2 * EarthLife::Unit(Id, 9), EarsNow);
				}
			}
		}
		else if (St.Lag > 0.0)
		{
			St.Lag = FMath::Max(0.0, St.Lag - Dt * 0.3);
		}
		if (!bGround)
		{
			continue;
		}
		// The body swings round to the way it is going, which is what turns it about at each end of a trip.
		St.Yaw = !St.bYawSet ? Want : St.Yaw + TurnTo(St.Yaw, Want) * Ease(Pose.bMoving ? 3.5 : 6.0, Dt);
		St.bYawSet = true;
		const FEarthRig& Rig = *Entry.Car->Looks.Rig;
		FBase Base;
		Base.Position = Engine(Pose.X, Y + RoadLiftM + (Pose.bMoving ? FMath::Abs(std::sin(T * 9.0 + Id)) * 0.02 : 0.0), Pose.Y);
		Base.Rotation = EarthRigs::Turned(0.0, St.Yaw, 0.0);
		Base.Size = Entry.Car->Looks.Size;
		Put(Rig, Rig.PaletteA[Entry.Car->Looks.Coat], Rig.PaletteB[Entry.Car->Looks.Coat], Base, AtRest, T);
	}

	// ---- trains: four carriages spread along the track, the middle of the train where the timetable puts it
	for (const FTrain* Train : Trains)
	{
		const EarthLife::FTrip& Trip = Train->Trip;
		const EarthLife::FTrainPose Pose = EarthLife::TrainPose(Trip, T);
		const double Middle = TrainM / 2.0 + (Pose.Along * (Trip.Length - TrainM)) / Trip.Length;
		double Nearest = TNumericLimits<double>::Max();
		for (int32 K = 0; K < Carriages; ++K)
		{
			const double D = Middle - TrainM / 2.0 + CarriageM / 2.0 + K * (CarriageM + CouplingM);
			const FVector2D At = EarthLife::PointAt(Trip, D);
			const double Away = std::hypot(At.X - Me.X, At.Y - Me.Y);
			Nearest = FMath::Min(Nearest, Away);
			double Y = 0.0;
			if (Away > TrainShowM || !World->TerrainHeightAt(At.X, At.Y, Y))
			{
				continue;
			}
			FBase Base;
			Base.Position = Engine(At.X, Y + RailLiftM, At.Y);
			Base.Rotation = EarthRigs::Turned(0.0, (-EarthLife::HeadingAt(Trip, D, 6.0) * Pi) / 180.0, 0.0);
			Put(*Train->Rig, Train->Rig->PaletteA[Train->Coat], Train->Rig->PaletteB[Train->Coat], Base, AtRest, T);
		}
		// It whistles as it sets off, and for anyone standing near the line as it passes.
		FTrainState& St = TrainStates.FindOrAdd(Trip.Id);
		if (!St.bSeen)
		{
			St.bSeen = true;
			St.bWasMoving = Pose.bMoving;
		}
		if (Nearest < 250.0 && T > St.WhistleAt && ((Pose.bMoving && !St.bWasMoving) || (Pose.bMoving && Nearest < 45.0)))
		{
			St.WhistleAt = T + 12.0;
			const FVector2D At = EarthLife::PointAt(Trip, Middle);
			double Y = MyHeight;
			World->TerrainHeightAt(At.X, At.Y, Y);
			if (Sounds)
			{
				Sounds->Play(TEXT("whistle"), Engine(At.X, Y + 3.0, At.Y), 0.92 + 0.16 * EarthLife::Unit(Trip.Id, 5), EarsNow);
			}
		}
		St.bWasMoving = Pose.bMoving;
	}
}

/** Writes one figure's shapes: each part where its role puts it, in the figure's colours. */
void AEarthLife::Put(const FEarthRig& Rig, const FLinearColor& CoatA, const FLinearColor& CoatB, const FBase& Base, const FPose& Pose, double T)
{
	for (const FEarthRigPart& Part : Rig.Parts)
	{
		if (Pose.bStandIn && Part.bSmall)
		{
			continue;
		}
		FQuat Turn = FQuat::Identity;
		bool bTurned = false;
		double DropCm = 0.0;
		switch (Part.Role)
		{
		case EEarthRole::None:
			break;
		case EEarthRole::Head:
			if (Pose.State)
			{
				Turn = EarthRigs::Turned(Pose.State->Head, Pose.State->Look, 0.0);
				DropCm = Rig.Graze != 0.0 ? Rig.Drop * FMath::Clamp(-Pose.State->Head / Rig.Graze, 0.0, 1.0) * 100.0 : 0.0;
				bTurned = true;
			}
			break;
		case EEarthRole::Tail:
		case EEarthRole::TailUp:
			if (!Pose.bStandIn)
			{
				Turn = EarthRigs::Turned(0.0, 0.0, std::sin(T * 2.2 * Pose.Wag + Pose.Beat) * (Pose.Wag > 1.0 ? 0.5 : 0.25));
				bTurned = true;
			}
			break;
		case EEarthRole::Wing0:
			Turn = EarthRigs::Turned(0.0, 0.0, -Pose.Flap);
			bTurned = true;
			break;
		case EEarthRole::Wing1:
			Turn = EarthRigs::Turned(0.0, 0.0, Pose.Flap);
			bTurned = true;
			break;
		default: // legs: opposite corners swing together, or all of them for an animal that hops
			Turn = EarthRigs::Turned(Pose.bTogether || Part.Role == EEarthRole::Leg0 || Part.Role == EEarthRole::Leg3 ? Pose.Swing : -Pose.Swing, 0.0, 0.0);
			bTurned = true;
			break;
		}
		// Turn the part about its pivot: move the pivot to the origin, rotate, move it back.
		const FVector Local = bTurned ? Part.PivotCm - FVector(0.0, 0.0, DropCm) + Turn.RotateVector(Part.AtCm - Part.PivotCm) : Part.AtCm;
		const FQuat Rotation = bTurned ? Base.Rotation * Turn * Part.TiltQuat : Base.Rotation * Part.TiltQuat;
		const int32 Shape = static_cast<int32>(Part.Shape);
		Transforms[Shape].Emplace(Rotation, Base.Position + Base.Rotation.RotateVector(Local * Base.Size), Part.Scale * Base.Size);
		const FLinearColor& Colour = Part.Colour == FEarthRigPart::CoatA ? CoatA : Part.Colour == FEarthRigPart::CoatB ? CoatB : Part.Paint;
		Colours[Shape].Add(Colour.R);
		Colours[Shape].Add(Colour.G);
		Colours[Shape].Add(Colour.B);
	}
}

/** Hands this frame's shapes to the four instanced meshes. Spare instances are kept, shrunk to nothing, for next time. */
void AEarthLife::Flush()
{
	const FTransform Hidden(FQuat::Identity, EarsNow, FVector::ZeroVector);
	for (int32 i = 0; i < NumShapes; ++i)
	{
		UInstancedStaticMeshComponent* Shape = Shapes[i];
		if (!Shape)
		{
			continue;
		}
		TArray<FTransform>& Wanted = Transforms[i];
		TArray<float>& Paint = Colours[i];
		const int32 Have = Shape->GetInstanceCount();
		if (Wanted.Num() > Have)
		{
			TArray<FTransform> More;
			More.Append(Wanted.GetData() + Have, Wanted.Num() - Have);
			Shape->AddInstances(More, /*bShouldReturnIndices*/ false, /*bWorldSpace*/ true, /*bUpdateNavigation*/ false);
		}
		while (Wanted.Num() < Have)
		{
			Wanted.Add(Hidden);
			Paint.Add(0.f);
			Paint.Add(0.f);
			Paint.Add(0.f);
		}
		if (Wanted.Num() > 0)
		{
			Shape->BatchUpdateInstancesTransforms(0, Wanted, /*bWorldSpace*/ true, /*bMarkRenderStateDirty*/ false, /*bTeleport*/ false);
			Shape->SetCustomData(0, Wanted.Num() - 1, Paint, /*bMarkRenderStateDirty*/ true);
		}
	}
}
