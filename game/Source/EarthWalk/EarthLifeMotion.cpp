#include "EarthLifeMotion.h"

#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

#include <cmath>

// The arithmetic below follows the JavaScript line for line, in the same order, in doubles, with the
// C library's own functions: the two must agree to the last digit that matters.

namespace
{
	constexpr uint32 SaltFocus = 0x464f4355;
	constexpr uint32 SaltSpot = 0x53504f54;
	constexpr uint32 SaltPhase = 0x50484153;
	constexpr uint32 SaltGraze = 0x47524153;
	constexpr uint32 SaltCall = 0x43414c4c;
	constexpr uint32 SaltFlock = 0x464c4f43;
	constexpr uint32 SaltLap = 0x4c415053;
	constexpr uint32 SaltTrip = 0x54524950;
	constexpr uint32 SaltTrain = 0x54524149;
	constexpr int64 Wrap = 0x40000000;
	constexpr double Pi = 3.141592653589793;
	constexpr double Turn = Pi * 2.0;
	/** Every this many steps the whole herd moves to another part of its circle. */
	constexpr int64 HerdSteps = 8;
	constexpr double KerbIn = 0.95;
	constexpr double EaseM = 10.0;
	constexpr double TurnM = 3.0;

	/** What JavaScript's `| 0` keeps of a whole number: its low 32 bits. */
	uint32 Bits(int64 Value) { return static_cast<uint32>(Value); }

	int64 Wrapped(int64 N) { return ((N % Wrap) + Wrap) % Wrap; }
	int64 FloorDiv(int64 N, int64 By) { return N >= 0 ? N / By : -((-N + By - 1) / By); }

	/** A point spread evenly over the unit disc, picked by a seed and a counter. x is east, y is south. */
	void Disc(uint32 Seed, int64 N, double& OutX, double& OutY)
	{
		const int64 K = Wrapped(N);
		const double Rad = std::sqrt(EarthLife::Unit(Seed, Bits(2 * K)));
		const double Ang = Turn * EarthLife::Unit(Seed, Bits(2 * K + 1));
		OutX = Rad * std::cos(Ang);
		OutY = Rad * std::sin(Ang);
	}

	/** A whole number of turns is dropped before taking the angle, so huge times lose no precision. */
	double Cycle(double T, double Seconds) { return Turn * std::fmod(T / Seconds, 1.0); }

	/** Compass heading in degrees of a direction (x east, y south): 0 north, 90 east. */
	double Heading(double Dx, double Dy)
	{
		return Dx == 0.0 && Dy == 0.0 ? 0.0 : std::fmod((std::atan2(Dx, -Dy) * 180.0) / Pi + 360.0, 360.0);
	}

	double Smooth(double G) { return G * G * (3.0 - 2.0 * G); }

	EarthLife::FCreature FlyerAt(const EarthLife::FHome& Home, int32 K, double T)
	{
		using namespace EarthLife;
		const FSpecies& Sp = *Home.Species;
		FCreature Out;
		Out.Id = MemberId(Home.Id, K);
		const uint32 Seed = Hash32(Home.Id, SaltFlock);
		const double Way = (Seed & 1) ? 1.0 : -1.0; // clockwise or not
		const double Lap = (Turn * Home.R * 0.7) / Sp.Pace; // seconds for one turn of the ring
		const double A = Way * Cycle(T, Lap) + Turn * Unit(Seed, 1);
		const double Ring = Home.R * (0.6 + 0.15 * std::sin(Cycle(T, 47.0) + Turn * Unit(Seed, 2)));
		const double Out0 = std::cos(A), Out1 = std::sin(A);
		const double Ahead0 = -Way * Out1, Ahead1 = Way * Out0;
		const double Row = std::ceil(K / 2.0);
		const double Side = K == 0 ? 0.0 : (K % 2) ? 1.0 : -1.0;
		const double Back = Row * 2.4 + 0.5 * std::sin(Cycle(T, 3.1) + K);
		const double Across = Side * Row * 1.7;
		Out.X = Out0 * (Ring + Across) - Ahead0 * Back;
		Out.Y = Out1 * (Ring + Across) - Ahead1 * Back;
		Out.Alt = 32.0 + 18.0 * Unit(Seed, 3) + 2.5 * std::sin(Cycle(T, 11.0) + K * 1.3);
		Out.Yaw = Heading(Ahead0, Ahead1);
		Out.bMoving = true;
		Out.Gait = std::fmod(T, 1000.0) * Sp.Pace;
		Out.Pace = Sp.Pace;
		return Out;
	}

	EarthLife::FCreature LapAt(const EarthLife::FHome& Home, int32 K, double T)
	{
		using namespace EarthLife;
		const FSpecies& Sp = *Home.Species;
		FCreature Out;
		Out.Id = MemberId(Home.Id, K);
		const uint32 Seed = Hash32(Home.Id, SaltLap);
		const double Way = (Seed & 1) ? 1.0 : -1.0;
		const double A = Home.R * 0.85;
		const double B = Home.R * 0.5;
		const double Round = Pi * (3.0 * (A + B) - std::sqrt((3.0 * A + B) * (A + 3.0 * B))); // the oval's length, near enough
		const double Th = Way * Cycle(T, Round / Sp.Pace) + Turn * Unit(Seed, 1);
		const double Tilt = Turn * Unit(Seed, 2);
		const double C = std::cos(Tilt);
		const double S = std::sin(Tilt);
		const double Ex = A * std::cos(Th);
		const double Ey = B * std::sin(Th);
		const double Dx = -A * std::sin(Th) * Way;
		const double Dy = B * std::cos(Th) * Way;
		Out.X = Ex * C - Ey * S;
		Out.Y = Ex * S + Ey * C;
		Out.Yaw = Heading(Dx * C - Dy * S, Dx * S + Dy * C);
		Out.bMoving = true;
		Out.Gait = std::fmod(T, 1000.0) * Sp.Pace;
		Out.Pace = Sp.Pace;
		return Out;
	}

	/** The stretch of path a thing is on `At` seconds after setting off: the points either side and how far between. */
	void Stretch(const EarthLife::FTrip& Trip, double At, int32& Lo, int32& Hi, double& F, double& Span)
	{
		const TArray<double>& P = Trip.Path;
		Lo = 0;
		Hi = Trip.N - 1;
		while (Hi - Lo > 1)
		{
			const int32 Mid = (Lo + Hi) >> 1;
			if (P[Mid * 3 + 2] <= At)
			{
				Lo = Mid;
			}
			else
			{
				Hi = Mid;
			}
		}
		Span = P[Hi * 3 + 2] - P[Lo * 3 + 2];
		F = Span > 0.0 ? FMath::Min(1.0, FMath::Max(0.0, (At - P[Lo * 3 + 2]) / Span)) : 0.0;
	}

	/** Which leg of the round trip, and how many seconds along the path, at time T. */
	void Timetable(const EarthLife::FTrip& Trip, uint32 Salt, double T, int32& Leg, double& At, double* OutTau = nullptr)
	{
		const double Tau = std::fmod(std::fmod(T + EarthLife::Unit(Trip.Id, Salt) * Trip.Period, Trip.Period) + Trip.Period, Trip.Period);
		if (OutTau)
		{
			*OutTau = Tau;
		}
		Leg = 0;
		At = 0.0;
		if (Tau >= Trip.Da + Trip.Time + Trip.Db)
		{
			Leg = 3;
			At = Trip.Time - (Tau - Trip.Da - Trip.Time - Trip.Db);
		}
		else if (Tau >= Trip.Da + Trip.Time)
		{
			Leg = 2;
			At = Trip.Time;
		}
		else if (Tau >= Trip.Da)
		{
			Leg = 1;
			At = Tau - Trip.Da;
		}
	}
}

uint32 EarthLife::Hash32(uint32 A, uint32 B)
{
	uint32 H = (A * 0x9e3779b1u) ^ (B * 0x85ebca6bu);
	H ^= H >> 15;
	H *= 0x2c1b3c6du;
	H ^= H >> 12;
	H *= 0x297a2d39u;
	H ^= H >> 15;
	return H;
}

const EarthLife::FSpecies* EarthLife::FindSpecies(const FString& Name)
{
	// The same table as SPECIES in lifemotion.js.
	static const FSpecies Table[] = {
		{ TEXT("cow"), 24, 0.35, 0.8, 14, false, false },
		{ TEXT("sheep"), 18, 0.35, 0.9, 11, false, false },
		{ TEXT("horse"), 20, 0.4, 1.4, 30, false, false },
		{ TEXT("chicken"), 5, 0.45, 1.1, 5, false, false },
		{ TEXT("duck"), 9, 0.6, 0.45, 9, false, false },
		{ TEXT("pigeon"), 4, 0.5, 0.5, 8, false, false },
		{ TEXT("cat"), 30, 0.2, 0.9, 40, false, false },
		{ TEXT("dog"), 9, 0.45, 1.5, 25, false, false },
		{ TEXT("rabbit"), 7, 0.3, 1.6, 0, false, false },
		{ TEXT("deer"), 22, 0.35, 1.1, 0, false, false },
		{ TEXT("squirrel"), 4, 0.45, 1.5, 0, false, false },
		{ TEXT("kangaroo"), 16, 0.3, 2.0, 0, false, false },
		{ TEXT("llama"), 22, 0.35, 0.9, 0, false, false },
		{ TEXT("camel"), 26, 0.35, 0.9, 0, false, false },
		{ TEXT("penguin"), 8, 0.5, 0.5, 12, false, false },
		{ TEXT("bird"), 1, 1, 9, 10, true, false },
		// The thirty-eight that came later: the farm, small things, the waterside, insects, and the big animals of one part of the world or another.
		{ TEXT("pig"), 14, 0.35, 0.8, 16, false, false },
		{ TEXT("goat"), 12, 0.4, 1, 14, false, false },
		{ TEXT("donkey"), 20, 0.35, 1, 30, false, false },
		{ TEXT("goose"), 8, 0.5, 0.6, 9, false, false },
		{ TEXT("mouse"), 3, 0.5, 1.2, 12, false, false },
		{ TEXT("hedgehog"), 10, 0.4, 0.4, 0, false, false },
		{ TEXT("fox"), 14, 0.4, 1.4, 0, false, false },
		{ TEXT("frog"), 6, 0.25, 1.2, 7, false, false },
		{ TEXT("snail"), 30, 0.9, 0.02, 0, false, false },
		{ TEXT("tortoise"), 20, 0.6, 0.12, 0, false, false },
		{ TEXT("crab"), 5, 0.5, 0.7, 0, false, false },
		{ TEXT("beaver"), 12, 0.4, 0.6, 0, false, false },
		{ TEXT("otter"), 6, 0.6, 0.9, 0, false, false },
		{ TEXT("swan"), 12, 0.6, 0.4, 0, false, false },
		{ TEXT("heron"), 40, 0.15, 0.5, 0, false, false },
		{ TEXT("seagull"), 7, 0.4, 0.6, 12, false, false },
		{ TEXT("sparrow"), 3, 0.4, 0.6, 6, false, false },
		{ TEXT("flamingo"), 14, 0.4, 0.5, 0, false, false },
		{ TEXT("seal"), 20, 0.3, 0.4, 0, false, false },
		{ TEXT("butterfly"), 4, 0.8, 1.2, 0, false, false },
		{ TEXT("bee"), 3, 0.8, 1.5, 6, false, false },
		{ TEXT("dragonfly"), 3, 0.7, 2.5, 0, false, false },
		{ TEXT("ladybird"), 8, 0.5, 0.12, 0, false, false },
		{ TEXT("ant"), 4, 0.7, 0.25, 0, false, false },
		{ TEXT("grasshopper"), 6, 0.25, 1.5, 0, false, false },
		{ TEXT("elephant"), 26, 0.4, 1, 40, false, false },
		{ TEXT("giraffe"), 24, 0.4, 1.1, 0, false, false },
		{ TEXT("zebra"), 18, 0.4, 1.3, 0, false, false },
		{ TEXT("lion"), 40, 0.15, 1, 0, false, false },
		{ TEXT("monkey"), 6, 0.45, 1.4, 0, false, false },
		{ TEXT("panda"), 30, 0.25, 0.6, 0, false, false },
		{ TEXT("koala"), 60, 0.1, 0.3, 0, false, false },
		{ TEXT("bear"), 24, 0.35, 1, 0, false, false },
		{ TEXT("moose"), 24, 0.35, 1, 0, false, false },
		{ TEXT("bison"), 24, 0.35, 0.9, 0, false, false },
		{ TEXT("reindeer"), 20, 0.35, 1.1, 0, false, false },
		{ TEXT("capybara"), 16, 0.35, 0.7, 0, false, false },
		{ TEXT("marmot"), 6, 0.35, 1, 0, false, false },
		{ TEXT("tractor"), 1, 1, 1.6, 2, false, true },
		{ TEXT("boat"), 1, 1, 0.5, 0, false, true },
		{ TEXT("sailboat"), 1, 1, 1.4, 0, false, true },
	};
	for (const FSpecies& Species : Table)
	{
		if (Name == Species.Name)
		{
			return &Species;
		}
	}
	return nullptr;
}

EarthLife::FCreature EarthLife::CreatureAt(const FHome& Home, int32 K, double T)
{
	const FSpecies& Sp = *Home.Species;
	if (Sp.bFly)
	{
		return FlyerAt(Home, K, T);
	}
	if (Sp.bLap)
	{
		return LapAt(Home, K, T);
	}
	const uint32 Id = MemberId(Home.Id, K);
	// Each animal shuffles about its own small patch; the patches sit round a point the herd shares.
	const double Patch = FMath::Min((Sp.Pace * Sp.Walk * Sp.Step) / 2.0, Home.R * 0.5);
	const double Room = FMath::Max(0.0, Home.R - Patch);
	// How far the shared point may be from the centre: small enough that moving with it is a trot, not a sprint.
	const double Drift = FMath::Min(Room * 0.4, 0.75 * Sp.Pace * Sp.Walk * Sp.Step);
	const double Spread = Room - Drift;
	const uint32 FocusSeed = Hash32(Home.Id, SaltFocus);
	double SpotX, SpotY;
	Disc(Hash32(Id, SaltSpot), 0, SpotX, SpotY);
	const auto Place = [&](int64 N, double& OutX, double& OutY)
	{
		double FocusX, FocusY, OwnX, OwnY;
		Disc(FocusSeed, FloorDiv(N, HerdSteps), FocusX, FocusY);
		Disc(Id, N, OwnX, OwnY);
		OutX = FocusX * Drift + SpotX * Spread + OwnX * Patch;
		OutY = FocusY * Drift + SpotY * Spread + OwnY * Patch;
	};

	const double Q = (T + Unit(Id, SaltPhase) * Sp.Step) / Sp.Step;
	const double Whole = std::floor(Q);
	const int64 N = static_cast<int64>(Whole);
	const double F = Q - Whole;
	const double Stand = 1.0 - Sp.Walk;
	double FromX, FromY, ToX, ToY;
	Place(N, FromX, FromY);
	Place(N + 1, ToX, ToY);
	const double Length = std::hypot(ToX - FromX, ToY - FromY);

	FCreature Out;
	Out.Id = Id;
	if (F < Stand)
	{
		double BeforeX, BeforeY;
		Place(N - 1, BeforeX, BeforeY);
		Out.X = FromX;
		Out.Y = FromY;
		Out.Yaw = Heading(FromX - BeforeX, FromY - BeforeY);
		Out.bGraze = Unit(Id, Bits(N % Wrap) ^ SaltGraze) < 0.7;
		return Out;
	}
	const double G = (F - Stand) / Sp.Walk;
	const double S = Smooth(G);
	Out.X = FromX + (ToX - FromX) * S;
	Out.Y = FromY + (ToY - FromY) * S;
	Out.Yaw = Heading(ToX - FromX, ToY - FromY);
	Out.bMoving = true;
	Out.Gait = Length * S;
	Out.Pace = (Length * 6.0 * G * (1.0 - G)) / (Sp.Walk * Sp.Step);
	return Out;
}

bool EarthLife::CallTime(uint32 Id, const FSpecies& Species, int64 Slot, double& OutTime)
{
	if (Species.Call <= 0)
	{
		return false;
	}
	const int64 K = Wrapped(Slot);
	if (Hash32(Id, Bits(K) ^ SaltCall) % static_cast<uint32>(Species.Call) != 0)
	{
		return false;
	}
	OutTime = (static_cast<double>(Slot) + Unit(Id, Bits(K + 1))) * CallSlot;
	return true;
}

void EarthLife::Prepare(FTrip& Trip)
{
	Trip.N = Trip.Path.Num() / 3;
	Trip.Dist.SetNumZeroed(FMath::Max(Trip.N, 1));
	for (int32 i = 1; i < Trip.N; ++i)
	{
		Trip.Dist[i] = Trip.Dist[i - 1] + std::hypot(Trip.Path[i * 3] - Trip.Path[i * 3 - 3], Trip.Path[i * 3 + 1] - Trip.Path[i * 3 - 2]);
	}
	Trip.Time = Trip.N > 0 ? Trip.Path[(Trip.N - 1) * 3 + 2] : 0.0;
	Trip.Length = Trip.N > 0 ? Trip.Dist[Trip.N - 1] : 0.0;
	Trip.Period = Trip.Da + Trip.Db + 2.0 * Trip.Time;
}

double EarthLife::LiftAt(const FTrip& Trip, double D)
{
	if (Trip.Lift.Num() != Trip.N || Trip.N < 2)
	{
		return 0.0;
	}
	int32 Lo = 0;
	int32 Hi = Trip.N - 1;
	while (Hi - Lo > 1)
	{
		const int32 Mid = (Lo + Hi) >> 1;
		if (Trip.Dist[Mid] <= D)
		{
			Lo = Mid;
		}
		else
		{
			Hi = Mid;
		}
	}
	const double Run = Trip.Dist[Hi] - Trip.Dist[Lo];
	const double F = Run > 0.0 ? FMath::Clamp((D - Trip.Dist[Lo]) / Run, 0.0, 1.0) : 0.0;
	return Trip.Lift[Lo] + (Trip.Lift[Hi] - Trip.Lift[Lo]) * F;
}

FVector2D EarthLife::PointAt(const FTrip& Trip, double D)
{
	const TArray<double>& P = Trip.Path;
	int32 Lo = 0;
	int32 Hi = Trip.N - 1;
	while (Hi - Lo > 1)
	{
		const int32 Mid = (Lo + Hi) >> 1;
		if (Trip.Dist[Mid] <= D)
		{
			Lo = Mid;
		}
		else
		{
			Hi = Mid;
		}
	}
	const double Run = Trip.Dist[Hi] - Trip.Dist[Lo];
	const double F = Run > 0.0 ? FMath::Min(1.0, FMath::Max(0.0, (D - Trip.Dist[Lo]) / Run)) : 0.0;
	return FVector2D(P[Lo * 3] + (P[Hi * 3] - P[Lo * 3]) * F, P[Lo * 3 + 1] + (P[Hi * 3 + 1] - P[Lo * 3 + 1]) * F);
}

double EarthLife::HeadingAt(const FTrip& Trip, double D, double Reach)
{
	const FVector2D A = PointAt(Trip, FMath::Max(0.0, D - Reach));
	const FVector2D B = PointAt(Trip, FMath::Min(Trip.Length, D + Reach));
	return std::fmod((std::atan2(B.X - A.X, -(B.Y - A.Y)) * 180.0) / Pi + 360.0, 360.0);
}

EarthLife::FTrainPose EarthLife::TrainPose(const FTrip& Train, double T)
{
	int32 Leg;
	double At, Tau;
	Timetable(Train, SaltTrain, T, Leg, At, &Tau);
	int32 Lo, Hi;
	double F, Span;
	Stretch(Train, At, Lo, Hi, F, Span);
	const double Run = Train.Dist[Hi] - Train.Dist[Lo];
	FTrainPose Out;
	Out.Along = Train.Dist[Lo] + Run * F;
	Out.bBack = Leg == 0 || Leg == 3;
	Out.bMoving = (Leg == 1 || Leg == 3) && Run > 0.0;
	Out.Leg = Leg;
	Out.Stood = Leg == 0 ? Tau : Leg == 2 ? Tau - Train.Da - Train.Time : 0.0;
	return Out;
}

EarthLife::FRunPose EarthLife::RunPose(const FTrip& Train, double Since, bool bBack)
{
	const double Gone = FMath::Clamp(Since, 0.0, Train.Time);
	const double At = bBack ? Train.Time - Gone : Gone;
	int32 Lo, Hi;
	double F, Span;
	Stretch(Train, At, Lo, Hi, F, Span);
	const double Run = Train.Dist[Hi] - Train.Dist[Lo];
	FRunPose Out;
	Out.Along = Train.Dist[Lo] + Run * F;
	Out.bMoving = Since > 0.0 && Since < Train.Time && Run > 0.0;
	Out.bDone = Since >= Train.Time;
	return Out;
}

const EarthLife::FTrip* EarthLife::JoinOf(const FTrip& Train, bool bFar, const TArray<const FTrip*>& Others, bool& bOutBack)
{
	const FVector2D End = PointAt(Train, bFar ? Train.Length : 0.0);
	const FVector2D Going = End - PointAt(Train, bFar ? Train.Length - 12.0 : 12.0); // the way it was going as it reached this end
	const FTrip* Best = nullptr;
	double Least = JoinM;
	for (const FTrip* Other : Others)
	{
		if (!Other || Other == &Train || Other->Id == Train.Id || Other->N < 2)
		{
			continue;
		}
		for (const bool bBack : { false, true })
		{
			const FVector2D Theirs = PointAt(*Other, bBack ? Other->Length : 0.0);
			const double D = FVector2D::Distance(Theirs, End);
			if (D >= Least)
			{
				continue;
			}
			const FVector2D On = PointAt(*Other, bBack ? Other->Length - 12.0 : 12.0) - Theirs; // the way it leads on from that end
			const double Bend = FMath::Abs(std::atan2(Going.X * On.Y - Going.Y * On.X, Going.X * On.X + Going.Y * On.Y));
			if (Bend > 1.2)
			{
				continue;
			}
			Least = D;
			Best = Other;
			bOutBack = bBack;
		}
	}
	return Best;
}

namespace
{
	EarthLife::FTripPose PoseWith(const EarthLife::FTrip& Trip, double T, const TFunctionRef<double(uint64)>* Hold, double Tuck);
}

EarthLife::FTripPose EarthLife::TripPose(const FTrip& Trip, double T)
{
	return PoseWith(Trip, T, nullptr, 0.0);
}

EarthLife::FTripPose EarthLife::TripPose(const FTrip& Trip, double T, TFunctionRef<double(uint64 Key)> Hold, double Tuck)
{
	return PoseWith(Trip, T, &Hold, Tuck);
}

EarthLife::FTripPose EarthLife::RestPose(const FTrip& Trip, bool bFar)
{
	const auto Nothing = [](uint64) { return 0.0; };
	return TripPose(Trip, (bFar ? Trip.Da + Trip.Time + 0.5 : 0.5) - Unit(Trip.Id, SaltTrip) * Trip.Period, Nothing);
}

EarthLife::FAlong EarthLife::AlongOf(const FTrip& Trip, double X, double Y)
{
	const TArray<double>& P = Trip.Path;
	FAlong Best;
	for (int32 i = 0; i + 1 < Trip.N; ++i)
	{
		const double Ax = P[i * 3], Ay = P[i * 3 + 1];
		const double Dx = P[i * 3 + 3] - Ax, Dy = P[i * 3 + 4] - Ay;
		const double Len = Trip.Dist[i + 1] - Trip.Dist[i];
		if (Len <= 0.0)
		{
			continue;
		}
		const double F = FMath::Min(1.0, FMath::Max(0.0, ((X - Ax) * Dx + (Y - Ay) * Dy) / (Len * Len)));
		const double D = std::hypot(X - Ax - Dx * F, Y - Ay - Dy * F);
		if (D < Best.D)
		{
			Best.Along = Trip.Dist[i] + Len * F;
			Best.Aside = ((X - Ax) * -Dy + (Y - Ay) * Dx) / Len;
			Best.D = D;
		}
	}
	return Best;
}

void EarthLife::SetSpots(const FTrip& Trip, const TArray<FSpotAt>& Spots)
{
	Trip.Spots.Reset();
	if (Trip.N < 2)
	{
		return;
	}
	const uint64 MineA = RestKey(Trip.Id, false), MineB = RestKey(Trip.Id, true);
	for (const FSpotAt& S : Spots)
	{
		if (S.Key == MineA || S.Key == MineB || FMath::Abs(S.X - Trip.Path[0]) > Trip.Length + 20.0 || FMath::Abs(S.Y - Trip.Path[1]) > Trip.Length + 20.0)
		{
			continue;
		}
		const FAlong At = AlongOf(Trip, S.X, S.Y);
		// Beside the road, not past an end of it, and not in the middle of it either.
		if (FMath::Abs(At.Aside) < 0.6 || FMath::Abs(At.Aside) > 7.0 || At.D > FMath::Abs(At.Aside) + 0.5)
		{
			continue;
		}
		Trip.Spots.Add({ At.Along, At.Aside, S.Key });
	}
}

namespace
{
EarthLife::FTripPose PoseWith(const EarthLife::FTrip& Trip, double T, const TFunctionRef<double(uint64)>* Hold, double Tuck)
{
	using namespace EarthLife;
	int32 Leg;
	double At; // seconds along the path
	Timetable(Trip, SaltTrip, T, Leg, At);
	const bool bBack = Leg == 0 || Leg == 3; // facing back towards the start

	const TArray<double>& P = Trip.Path;
	int32 Lo, Hi;
	double F, Span;
	Stretch(Trip, At, Lo, Hi, F, Span);
	const double Run = Trip.Dist[Hi] - Trip.Dist[Lo];
	const double Along = Trip.Dist[Lo] + Run * F;
	// The way it faces: along the road from a little behind it to a little ahead.
	const FVector2D Behind = PointAt(Trip, FMath::Max(0.0, Along - TurnM));
	const FVector2D Ahead = PointAt(Trip, FMath::Min(Trip.Length, Along + TurnM));
	const double Reach = std::hypot(Ahead.X - Behind.X, Ahead.Y - Behind.Y) * (bBack ? -1.0 : 1.0);
	const double Dx = Reach != 0.0 ? (Ahead.X - Behind.X) / Reach : 0.0;
	const double Dy = Reach != 0.0 ? (Ahead.Y - Behind.Y) / Reach : 0.0;

	// How far over from the middle of the road: it sets off from the far kerb (it was facing the other
	// way), settles into its lane, and pulls in to the kerb on its own side at the end.
	const double Driven = bBack ? Trip.Length - Along : Along;
	const double Kerb = FMath::Max(0.6, Trip.W / 2.0 - KerbIn);
	const double Lane = FMath::Min(Trip.W / 4.0, Kerb);
	const double Hand = Trip.bLeft ? -1.0 : 1.0;
	const double G0 = Smooth(FMath::Min(1.0, Driven / EaseM));
	const double G1 = Smooth(FMath::Min(1.0, (Trip.Length - Driven) / EaseM));
	// Its own side of the road, as the path sees it: to the right of the way out, or to the left.
	const double Mine = Hand * (bBack ? -1.0 : 1.0);
	const bool bSpots = Trip.Spots.Num() > 0;
	/** How far over from the middle it is, towards its own kerb, once it has driven Dr metres of this leg. */
	const auto OwnAt = [&](double Dr)
	{
		const double D = FMath::Min(Trip.Length, FMath::Max(0.0, Dr));
		const double E0 = Smooth(FMath::Min(1.0, D / EaseM));
		const double E1 = Smooth(FMath::Min(1.0, (Trip.Length - D) / EaseM));
		const double Eased = (Lane * E0 - Kerb * (1.0 - E0)) * E1 + Kerb * (1.0 - E1);
		const double Own = Tuck > 0.0 ? Eased + (Kerb - Eased) * Tuck * E0 : Eased;
		if (!bSpots)
		{
			return Own;
		}
		// Cars at the kerb: it keeps clear of each one it is beside, steering out before it and back in after.
		const double Here = bBack ? Trip.Length - D : D;
		const double Free = Smooth(FMath::Min(1.0, FMath::Min(D, Trip.Length - D) / EndFreeM));
		double Most = TNumericLimits<double>::Max();     // the furthest towards its own kerb it may be
		double Least = -TNumericLimits<double>::Max();   // and the furthest towards the other
		for (const FKerbSpot& S : Trip.Spots)
		{
			const double Gap = FMath::Abs(S.Along - Here);
			if (Gap >= AbeamM + SwerveM)
			{
				continue;
			}
			const double Counts = Hold ? (*Hold)(S.Key) : 1.0;
			if (!(Counts > 0.0))
			{
				continue;
			}
			const double Weight = (Gap <= AbeamM ? 1.0 : 1.0 - Smooth((Gap - AbeamM) / SwerveM)) * FMath::Min(1.0, Counts) * Free;
			// (It moves over from where it would have been, no further than it must: so it steers gently.)
			const double Room = FMath::Abs(S.Aside) - CarWide - KerbGap;
			if ((S.Aside > 0.0 ? 1.0 : -1.0) == Mine)
			{
				if (Room < Own)
				{
					Most = FMath::Min(Most, Own + (Room - Own) * Weight);
				}
			}
			else if (-Room > Own)
			{
				Least = FMath::Max(Least, Own + (-Room - Own) * Weight);
			}
		}
		// (Cars at both kerbs with too little room between them: down the middle of what room there is.)
		return Most < Least ? (Most + Least) / 2.0 : FMath::Min(Most, FMath::Max(Least, Own));
	};
	const double OwnNow = OwnAt(Driven);
	const double Over = OwnNow * Hand;
	// It points a little the way it is steering, as it pulls out, pulls in and goes round a car at the kerb:
	// half the turn its path makes, so that its corners do not swing into what it is passing.
	const double Lean = bSpots || G0 < 1.0 || G1 < 1.0
		? FMath::Max(-0.3, FMath::Min(0.3, std::atan((OwnAt(Driven + 0.6) - OwnAt(Driven - 0.6)) / 1.2) * SteerShown)) * Hand
		: 0.0;

	FTripPose Out;
	Out.bMoving = Leg == 1 || Leg == 3;
	Out.X = P[Lo * 3] + (P[Hi * 3] - P[Lo * 3]) * F - Dy * Over; // to the right of the way it faces is (-dy, dx)
	Out.Y = P[Lo * 3 + 1] + (P[Hi * 3 + 1] - P[Lo * 3 + 1]) * F + Dx * Over;
	Out.Yaw = std::fmod(((std::atan2(Dx, -Dy) + (Out.bMoving ? Lean : 0.0)) * 180.0) / Pi + 360.0, 360.0);
	Out.Leg = Leg;
	Out.Pace = Out.bMoving && Span > 0.0 ? Run / Span : 0.0;
	Out.bInLane = Out.bMoving && G0 == 1.0 && G1 == 1.0;
	Out.Lift = LiftAt(Trip, Along);
	Out.Rolled = Driven;
	Out.bOut = Out.bMoving && G0 == 1.0 && G1 == 1.0 && Lane - OwnNow > 0.3 && !(Tuck > 0.0);
	return Out;
}
}

// ---------------------------------------------------------------- giving way (trafficmotion.js, under that heading)

namespace
{
	constexpr double LookS[EarthLife::NumLooks] = { 0.6, 1.2, 1.8, 2.4, 3.0, 3.6, 4.2, 5.4, 6.6, 7.8, 9.0, 10.2, 11.4, 12.6 };

	EarthLife::FCarBox BoxOf(const EarthLife::FTripPose& Pose)
	{
		const double A = (Pose.Yaw * Pi) / 180.0;
		return { Pose.X, Pose.Y, std::sin(A), -std::cos(A) };
	}
}

bool EarthLife::BoxesMeet(const FCarBox& A, const FCarBox& B, double Long, double Wide)
{
	const double HalfLong = Long / 2.0;
	const double HalfWide = Wide / 2.0;
	const double Rx = B.X - A.X, Ry = B.Y - A.Y;
	if (Rx * Rx + Ry * Ry > 36.0)
	{
		return false;
	}
	// Along each box's two axes in turn: apart along any one of them is apart.
	const double Dot = FMath::Abs(A.Fx * B.Fx + A.Fy * B.Fy), Cross = FMath::Abs(A.Fx * B.Fy - A.Fy * B.Fx);
	if (FMath::Abs(Rx * A.Fx + Ry * A.Fy) > HalfLong + HalfLong * Dot + HalfWide * Cross) { return false; }
	if (FMath::Abs(-Rx * A.Fy + Ry * A.Fx) > HalfWide + HalfLong * Cross + HalfWide * Dot) { return false; }
	if (FMath::Abs(Rx * B.Fx + Ry * B.Fy) > HalfLong + HalfLong * Dot + HalfWide * Cross) { return false; }
	if (FMath::Abs(-Rx * B.Fy + Ry * B.Fx) > HalfWide + HalfLong * Cross + HalfWide * Dot) { return false; }
	return true;
}

void EarthLife::GiveWay(TArray<FGivingCar>& Cars, double T, double Dt, TFunctionRef<bool(uint32 ParkedId)> Gone, TFunctionRef<bool(const FGivingCar& Car)> Also)
{
	// What stands at each trip's two ends just now, for the cars that steer round them.
	TMap<uint64, double> Rests;
	Rests.Reserve(Cars.Num() * 2);
	const auto Nothing = [](uint64) { return 0.0; };
	for (FGivingCar& C : Cars)
	{
		const FTripPose Raw = TripPose(*C.Trip, T - C.St->Lag, Nothing);
		const double Left = 1.0 - Smooth(FMath::Min(1.0, Raw.Rolled / EaseM));
		const double Come = 1.0 - Smooth(FMath::Min(1.0, (C.Trip->Length - Raw.Rolled) / EaseM));
		const double AtStart = Raw.Leg == 0 ? 1.0 : Raw.Leg == 2 ? 0.0 : Raw.Leg == 1 ? Left : Come;
		const double AtFar = Raw.Leg == 0 ? 0.0 : Raw.Leg == 2 ? 1.0 : Raw.Leg == 1 ? Come : Left;
		Rests.Add(RestKey(C.Trip->Id, false), AtStart);
		Rests.Add(RestKey(C.Trip->Id, true), AtFar);
	}
	const auto Hold = [&](uint64 Key) -> double
	{
		if ((Key >> 32) == 1)
		{
			return Gone(static_cast<uint32>(Key)) ? 0.0 : 1.0; // a parked car
		}
		const double* Found = Rests.Find(Key);
		return Found ? *Found : 0.0;
	};
	for (FGivingCar& C : Cars)
	{
		const double Tau = T - C.St->Lag;
		C.Pose = TripPose(*C.Trip, Tau, Hold, C.St->Tuck);
		C.Box = BoxOf(C.Pose);
		C.bGoing = C.Pose.bMoving;
		for (int32 i = 0; i < NumLooks; ++i)
		{
			const FTripPose Then = TripPose(*C.Trip, Tau + LookS[i], Hold);
			C.bAhead[i] = Then.bMoving;
			if (Then.bMoving)
			{
				C.Ahead[i] = BoxOf(Then);
				C.bGoing = true;
			}
		}
		// Who gives way to whom when two would meet: a car pulling out waits for one in its lane, and a car in its
		// lane for one that is already out round a parked car or pulling in.
		const double ToGo = C.Trip->Length - C.Pose.Rolled;
		C.Rank = !C.Pose.bMoving || C.Pose.Rolled < EaseM ? 0 : C.Pose.bOut || ToGo < EaseM ? 2 : 1;
		C.Waits = 0; // 2: for something it is about to run into; 1: for a car coming the other way through a narrow stretch ahead
		C.bJam = false;
	}
	/**
	 * Whether A, going on as its timetable has it, would run into B: where B will be, or where B stands if it is
	 * waiting. 2: within the next few seconds. 1: later than that, head on. 0: no.
	 */
	const auto WouldHit = [](const FGivingCar& A, const FGivingCar& B)
	{
		const bool bStill = B.St->bBlocked;
		for (int32 i = 0; i < NumLooks; ++i)
		{
			if (!A.bAhead[i])
			{
				continue;
			}
			const FCarBox& Ours = A.Ahead[i];
			const bool bFar = i >= NumNear;
			if (bStill)
			{
				if (!bFar && BoxesMeet(Ours, B.Box))
				{
					return 2;
				}
				continue;
			}
			for (int32 j = i - 1; j <= i + 1; ++j)
			{
				if (j >= NumLooks)
				{
					continue;
				}
				// Where B will be then: or, if its timetable has it at rest by then, where it was last on the move.
				const FCarBox* Theirs = &B.Box;
				for (int32 k = j; k >= 0; --k)
				{
					if (B.bAhead[k])
					{
						Theirs = &B.Ahead[k];
						break;
					}
				}
				if (bFar && Ours.Fx * Theirs->Fx + Ours.Fy * Theirs->Fy > -0.7)
				{
					continue;
				}
				if (BoxesMeet(Ours, *Theirs))
				{
					return bFar ? 1 : 2;
				}
			}
		}
		return 0;
	};
	for (int32 i = 0; i < Cars.Num(); ++i)
	{
		FGivingCar& A = Cars[i];
		for (int32 j = i + 1; j < Cars.Num(); ++j)
		{
			FGivingCar& B = Cars[j];
			if (!A.bGoing || !B.bGoing)
			{
				continue; // (a car at rest at the kerb is steered round, not waited for)
			}
			const double Rx = B.Box.X - A.Box.X, Ry = B.Box.Y - A.Box.Y;
			if (Rx * Rx + Ry * Ry > 150.0 * 150.0 || BoxesMeet(A.Box, B.Box))
			{
				continue; // (inside each other already: nothing is gained by holding them there)
			}
			const int32 Ab = T < A.St->Ghost ? 0 : WouldHit(A, B);
			const int32 Ba = T < B.St->Ghost ? 0 : WouldHit(B, A);
			if (!Ab && !Ba)
			{
				continue;
			}
			if (Ab && Ba)
			{
				// Each would run into the other. If one is standing already, the other cannot go through it, so both
				// stand: a jam, once both have. Otherwise the one behind waits; and of two that face each other, the
				// one of lower rank.
				if (A.St->bBlocked || B.St->bBlocked)
				{
					if (A.St->bBlocked && B.St->bBlocked && Ab == 2 && Ba == 2)
					{
						A.bJam = B.bJam = true;
					}
					A.Waits = FMath::Max(A.Waits, Ab);
					B.Waits = FMath::Max(B.Waits, Ba);
					continue;
				}
				const double AheadOfA = Rx * A.Box.Fx + Ry * A.Box.Fy;       // how far B is in front of A
				const double AheadOfB = -(Rx * B.Box.Fx + Ry * B.Box.Fy);    // and A in front of B
				const bool bABehind = AheadOfA > 0.0 && AheadOfB <= 0.0;
				const bool bBBehind = AheadOfB > 0.0 && AheadOfA <= 0.0;
				const bool bAWaits = bABehind ? true : bBBehind ? false : A.Rank != B.Rank ? A.Rank < B.Rank : A.Trip->Id > B.Trip->Id;
				if (bAWaits)
				{
					A.Waits = FMath::Max(A.Waits, Ab);
				}
				else
				{
					B.Waits = FMath::Max(B.Waits, Ba);
				}
			}
			else if (Ab)
			{
				A.Waits = FMath::Max(A.Waits, Ab);
			}
			else
			{
				B.Waits = FMath::Max(B.Waits, Ba);
			}
		}
	}
	const double Ease = 1.0 - std::exp(-5.0 * Dt);
	for (FGivingCar& C : Cars)
	{
		FGiveState& St = *C.St;
		// Two that wait for each other: after a while the one with the smaller number goes, through the other if need be.
		St.Stuck = C.bJam ? St.Stuck + Dt : 0.0;
		if (St.Stuck > StuckS + static_cast<double>(C.Trip->Id % 7))
		{
			St.Ghost = T + 6.0;
			St.Stuck = 0.0;
			C.Waits = 0;
		}
		// For a car coming through a narrow stretch it waits where there is room: so, out round a parked car
		// itself, it goes on until it is back in its lane, and waits there.
		const bool bByCar = C.Waits == 2 || (C.Waits == 1 && !C.Pose.bOut);
		// (A car that has fallen as far behind as it may stops waiting, and drives on.)
		const bool bBlocked = (bByCar || Also(C)) && St.Lag < LagMostS;
		// Held back, its clock stops; free again, it makes the time up: gently on the road, at once while it stands at a kerb.
		const double Want = bBlocked ? 1.0 : bByCar || St.Lag <= 0.0 ? 0.0 : C.Pose.bMoving ? -0.3 : -1.0;
		St.Rate += (Want - St.Rate) * Ease;
		St.Lag = FMath::Min(LagMostS, FMath::Max(0.0, St.Lag + St.Rate * Dt));
		if (St.Lag == 0.0 && St.Rate < 0.0)
		{
			St.Rate = 0.0;
		}
		// Standing for another car, it draws in to its kerb as far as there is room, to let the other by.
		St.Tuck = FMath::Min(1.0, FMath::Max(0.0, St.Tuck + (bBlocked && bByCar && St.Rate > 0.8 ? Dt : -Dt) * 1.2));
		St.bBlocked = bBlocked;
		St.bByCar = bByCar;
	}
}

// ---------------------------------------------------------------- the check against the JavaScript

namespace
{
	struct FTally
	{
		int32 Checks = 0;
		int32 Wrong = 0; // yes-or-no answers and whole numbers that differ
		double Worst = 0.0; // metres, seconds or degrees

		void Same(bool bSame)
		{
			++Checks;
			Wrong += bSame ? 0 : 1;
		}
		FString First; // the first number that was out by more than a hair, for finding what went wrong
		void Near(double Ours, double Theirs, const TCHAR* What = TEXT(""))
		{
			++Checks;
			Worst = FMath::Max(Worst, FMath::Abs(Ours - Theirs));
			if (FMath::Abs(Ours - Theirs) > 1e-6 && First.IsEmpty())
			{
				First = FString::Printf(TEXT("check %d %s: ours %.9f, theirs %.9f"), Checks, What, Ours, Theirs);
			}
		}
		void NearAngle(double Ours, double Theirs, const TCHAR* What = TEXT(""))
		{
			++Checks;
			Worst = FMath::Max(Worst, FMath::Abs(FMath::FindDeltaAngleDegrees(Ours, Theirs)));
			if (FMath::Abs(FMath::FindDeltaAngleDegrees(Ours, Theirs)) > 1e-6 && First.IsEmpty())
			{
				First = FString::Printf(TEXT("check %d %s: ours %.9f, theirs %.9f degrees"), Checks, What, Ours, Theirs);
			}
		}
	};

	EarthLife::FTrip ReadTrip(const FJsonObject& Json)
	{
		EarthLife::FTrip Trip;
		Trip.Id = static_cast<uint32>(Json.GetNumberField(TEXT("id")));
		Trip.W = Json.GetNumberField(TEXT("w"));
		Trip.bLeft = Json.GetBoolField(TEXT("left"));
		Trip.Da = Json.GetNumberField(TEXT("da"));
		Trip.Db = Json.GetNumberField(TEXT("db"));
		for (const TSharedPtr<FJsonValue>& Value : Json.GetArrayField(TEXT("path")))
		{
			Trip.Path.Add(Value->AsNumber());
		}
		EarthLife::Prepare(Trip);
		return Trip;
	}
}

bool EarthLife::RunSelfTest(const FString& JsonFile)
{
	FString Text;
	TSharedPtr<FJsonObject> Root;
	if (!FFileHelper::LoadFileToString(Text, *JsonFile) || !FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), Root) || !Root.IsValid())
	{
		UE_LOG(LogTemp, Error, TEXT("EarthWalk: life test: cannot read %s"), *JsonFile);
		return false;
	}
	FTally Hashes, Creatures, Calls, Cars, Trains, Kerbs, Giving;

	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("hashes")))
	{
		const FJsonObject& Row = *Value->AsObject();
		Hashes.Same(Hash32(static_cast<uint32>(Row.GetNumberField(TEXT("a"))), static_cast<uint32>(Row.GetNumberField(TEXT("b")))) == static_cast<uint32>(Row.GetNumberField(TEXT("h"))));
	}
	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("creatures")))
	{
		const FJsonObject& Row = *Value->AsObject();
		const FJsonObject& HomeJson = *Row.GetObjectField(TEXT("home"));
		FHome Home;
		Home.Id = static_cast<uint32>(HomeJson.GetNumberField(TEXT("id")));
		Home.Species = FindSpecies(HomeJson.GetStringField(TEXT("sp")));
		Home.N = static_cast<int32>(HomeJson.GetNumberField(TEXT("n")));
		Home.R = HomeJson.GetNumberField(TEXT("r"));
		if (!Home.Species)
		{
			Creatures.Same(false);
			continue;
		}
		const FCreature C = CreatureAt(Home, static_cast<int32>(Row.GetNumberField(TEXT("k"))), Row.GetNumberField(TEXT("t")));
		Creatures.Same(C.Id == static_cast<uint32>(Row.GetNumberField(TEXT("id"))));
		Creatures.Same(C.bMoving == Row.GetBoolField(TEXT("moving")));
		Creatures.Same(C.bGraze == Row.GetBoolField(TEXT("graze")));
		Creatures.Near(C.X, Row.GetNumberField(TEXT("x")));
		Creatures.Near(C.Y, Row.GetNumberField(TEXT("y")));
		Creatures.Near(C.Alt, Row.GetNumberField(TEXT("alt")));
		Creatures.Near(C.Gait, Row.GetNumberField(TEXT("gait")));
		Creatures.Near(C.Pace, Row.GetNumberField(TEXT("pace")));
		Creatures.NearAngle(C.Yaw, Row.GetNumberField(TEXT("yaw")));
	}
	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("calls")))
	{
		const FJsonObject& Row = *Value->AsObject();
		const FSpecies* Species = FindSpecies(Row.GetStringField(TEXT("sp")));
		double Theirs = 0.0, Ours = 0.0;
		const bool bTheirs = Row.TryGetNumberField(TEXT("at"), Theirs);
		const bool bOurs = Species && CallTime(static_cast<uint32>(Row.GetNumberField(TEXT("id"))), *Species, static_cast<int64>(Row.GetNumberField(TEXT("slot"))), Ours);
		Calls.Same(bOurs == bTheirs);
		if (bOurs && bTheirs)
		{
			Calls.Near(Ours, Theirs);
		}
	}
	TArray<FTrip> TripList, TrainList;
	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("trips")))
	{
		TripList.Add(ReadTrip(*Value->AsObject()));
	}
	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("trains")))
	{
		TrainList.Add(ReadTrip(*Value->AsObject()));
	}
	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("tripPoses")))
	{
		const FJsonObject& Row = *Value->AsObject();
		const FTripPose Pose = TripPose(TripList[static_cast<int32>(Row.GetNumberField(TEXT("trip")))], Row.GetNumberField(TEXT("t")));
		Cars.Same(Pose.Leg == static_cast<int32>(Row.GetNumberField(TEXT("leg"))));
		Cars.Same(Pose.bMoving == Row.GetBoolField(TEXT("moving")));
		Cars.Same(Pose.bInLane == Row.GetBoolField(TEXT("inLane")));
		Cars.Near(Pose.X, Row.GetNumberField(TEXT("x")));
		Cars.Near(Pose.Y, Row.GetNumberField(TEXT("y")));
		Cars.Near(Pose.Pace, Row.GetNumberField(TEXT("pace")));
		Cars.NearAngle(Pose.Yaw, Row.GetNumberField(TEXT("yaw")));
	}
	for (const TSharedPtr<FJsonValue>& Value : Root->GetArrayField(TEXT("trainPoses")))
	{
		const FJsonObject& Row = *Value->AsObject();
		const FTrip& Train = TrainList[static_cast<int32>(Row.GetNumberField(TEXT("train")))];
		const FTrainPose Pose = TrainPose(Train, Row.GetNumberField(TEXT("t")));
		const FVector2D At = PointAt(Train, Pose.Along);
		Trains.Same(Pose.Leg == static_cast<int32>(Row.GetNumberField(TEXT("leg"))));
		Trains.Same(Pose.bMoving == Row.GetBoolField(TEXT("moving")));
		Trains.Same(Pose.bBack == Row.GetBoolField(TEXT("back")));
		Trains.Near(Pose.Along, Row.GetNumberField(TEXT("along")));
		Trains.Near(At.X, Row.GetNumberField(TEXT("x")));
		Trains.Near(At.Y, Row.GetNumberField(TEXT("y")));
		Trains.Near(Train.Length, Row.GetNumberField(TEXT("length")));
		Trains.Near(Train.Period, Row.GetNumberField(TEXT("period")));
		Trains.NearAngle(HeadingAt(Train, Pose.Along, 6.0), Row.GetNumberField(TEXT("heading")));
	}

	// ---- a street with cars parked along it and four cars driving up and down it: steering round, and giving way
	const TSharedPtr<FJsonObject>* KerbJson = nullptr;
	if (Root->TryGetObjectField(TEXT("kerb"), KerbJson) && KerbJson && KerbJson->IsValid())
	{
		const FJsonObject& Kerb = **KerbJson;
		TArray<FTrip> Street;
		for (const TSharedPtr<FJsonValue>& Value : Kerb.GetArrayField(TEXT("trips")))
		{
			Street.Add(ReadTrip(*Value->AsObject()));
		}
		TArray<FSpotAt> Spots;
		for (const TSharedPtr<FJsonValue>& Value : Kerb.GetArrayField(TEXT("parked")))
		{
			const FJsonObject& Row = *Value->AsObject();
			Spots.Add({ Row.GetNumberField(TEXT("x")), Row.GetNumberField(TEXT("y")), ParkedKey(static_cast<uint32>(Row.GetNumberField(TEXT("id")))) });
		}
		for (const TSharedPtr<FJsonValue>& Value : Kerb.GetArrayField(TEXT("rests")))
		{
			const FJsonObject& Row = *Value->AsObject();
			const FTrip& Trip = Street[static_cast<int32>(Row.GetNumberField(TEXT("trip")))];
			const bool bFar = Row.GetBoolField(TEXT("far"));
			const FTripPose At = RestPose(Trip, bFar);
			Kerbs.Near(At.X, Row.GetNumberField(TEXT("x")), TEXT("rest x"));
			Kerbs.Near(At.Y, Row.GetNumberField(TEXT("y")), TEXT("rest y"));
			Kerbs.NearAngle(At.Yaw, Row.GetNumberField(TEXT("yaw")), TEXT("rest yaw"));
			Spots.Add({ At.X, At.Y, RestKey(Trip.Id, bFar) });
		}
		const TArray<TSharedPtr<FJsonValue>>& SpotLists = Kerb.GetArrayField(TEXT("spots"));
		for (int32 n = 0; n < Street.Num(); ++n)
		{
			SetSpots(Street[n], Spots);
			const TArray<TSharedPtr<FJsonValue>>& Theirs = SpotLists[n]->AsArray();
			Kerbs.Same(Theirs.Num() == Street[n].Spots.Num());
			for (int32 k = 0; k < FMath::Min(Theirs.Num(), Street[n].Spots.Num()); ++k)
			{
				Kerbs.Near(Street[n].Spots[k].Along, Theirs[k]->AsObject()->GetNumberField(TEXT("along")), TEXT("spot along"));
				Kerbs.Near(Street[n].Spots[k].Aside, Theirs[k]->AsObject()->GetNumberField(TEXT("aside")), TEXT("spot aside"));
			}
		}
		const auto SomeHold = [](uint64 Key) { return (Key >> 32) == 1 ? static_cast<double>(static_cast<uint32>(Key) % 3) / 2.0 : 0.5; };
		for (const TSharedPtr<FJsonValue>& Value : Kerb.GetArrayField(TEXT("poses")))
		{
			const FJsonObject& Row = *Value->AsObject();
			const FTrip& Trip = Street[static_cast<int32>(Row.GetNumberField(TEXT("trip")))];
			const FTripPose All = TripPose(Trip, Row.GetNumberField(TEXT("t")));
			const FTripPose Some = TripPose(Trip, Row.GetNumberField(TEXT("t")), SomeHold, 0.4);
			Kerbs.Near(All.X, Row.GetNumberField(TEXT("x")), TEXT("x, every spot taken"));
			Kerbs.Near(All.Y, Row.GetNumberField(TEXT("y")), TEXT("y, every spot taken"));
			Kerbs.NearAngle(All.Yaw, Row.GetNumberField(TEXT("yaw")), TEXT("yaw, every spot taken"));
			Kerbs.Same(All.bOut == Row.GetBoolField(TEXT("out")));
			Kerbs.Near(Some.X, Row.GetNumberField(TEXT("sx")), TEXT("x, some spots taken"));
			Kerbs.Near(Some.Y, Row.GetNumberField(TEXT("sy")), TEXT("y, some spots taken"));
			Kerbs.NearAngle(Some.Yaw, Row.GetNumberField(TEXT("syaw")), TEXT("yaw, some spots taken"));
			Kerbs.Same(Some.bOut == Row.GetBoolField(TEXT("sout")));
		}
		const FJsonObject& Give = *Kerb.GetObjectField(TEXT("give"));
		const double Start = Give.GetNumberField(TEXT("t0")), Step = Give.GetNumberField(TEXT("dt"));
		const int32 Steps = static_cast<int32>(Give.GetNumberField(TEXT("steps"))), Every = static_cast<int32>(Give.GetNumberField(TEXT("every")));
		TArray<FGiveState> States;
		States.SetNum(Street.Num());
		TArray<FGivingCar> Going;
		Going.SetNum(Street.Num());
		for (int32 n = 0; n < Street.Num(); ++n)
		{
			Going[n].Trip = &Street[n];
			Going[n].St = &States[n];
		}
		const TArray<TSharedPtr<FJsonValue>>& Rows = Give.GetArrayField(TEXT("rows"));
		int32 Next = 0;
		for (int32 i = 1; i <= Steps; ++i)
		{
			GiveWay(Going, Start + i * Step, Step, [](uint32 ParkedId) { return ParkedId == 15; }, [](const FGivingCar&) { return false; });
			if (i % Every != 0)
			{
				continue;
			}
			for (int32 n = 0; n < Street.Num() && Next < Rows.Num(); ++n, ++Next)
			{
				const FJsonObject& Row = *Rows[Next]->AsObject();
				Giving.Same(static_cast<int32>(Row.GetNumberField(TEXT("step"))) == i && static_cast<int32>(Row.GetNumberField(TEXT("car"))) == n);
				Giving.Same(States[n].bBlocked == Row.GetBoolField(TEXT("blocked")));
				Giving.Near(Going[n].Pose.X, Row.GetNumberField(TEXT("x")));
				Giving.Near(Going[n].Pose.Y, Row.GetNumberField(TEXT("y")));
				Giving.NearAngle(Going[n].Pose.Yaw, Row.GetNumberField(TEXT("yaw")));
				Giving.Near(States[n].Lag, Row.GetNumberField(TEXT("lag")));
				Giving.Near(States[n].Tuck, Row.GetNumberField(TEXT("tuck")));
			}
		}
		Giving.Same(Next == Rows.Num());
	}

	const auto Report = [](const TCHAR* What, const FTally& Tally)
	{
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: life test: %s: %d checks, %d wrong, largest difference %.3g"), What, Tally.Checks, Tally.Wrong, Tally.Worst);
		if (!Tally.First.IsEmpty())
		{
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: life test: %s: the first that was out: %s"), What, *Tally.First);
		}
		return Tally.Checks > 0 && Tally.Wrong == 0 && Tally.Worst < 1e-6;
	};
	// Not short-circuited: every line is wanted in the log.
	const bool bHashes = Report(TEXT("hashes"), Hashes);
	const bool bCreatures = Report(TEXT("animals"), Creatures);
	const bool bCalls = Report(TEXT("calls"), Calls);
	const bool bCars = Report(TEXT("cars"), Cars);
	const bool bTrains = Report(TEXT("trains"), Trains);
	const bool bKerbs = Report(TEXT("cars beside parked cars"), Kerbs);
	const bool bGiving = Report(TEXT("cars giving way"), Giving);
	const bool bOk = bHashes && bCreatures && bCalls && bCars && bTrains && bKerbs && bGiving;
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: life test: %s"), bOk ? TEXT("PASSED, the same answers as the browser") : TEXT("FAILED"));
	return bOk;
}
