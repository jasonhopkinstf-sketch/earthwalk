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

EarthLife::FTripPose EarthLife::TripPose(const FTrip& Trip, double T)
{
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
	const double G0 = Smooth(FMath::Min(1.0, Driven / EaseM));
	const double G1 = Smooth(FMath::Min(1.0, (Trip.Length - Driven) / EaseM));
	const double Over = ((Lane * G0 - Kerb * (1.0 - G0)) * G1 + Kerb * (1.0 - G1)) * (Trip.bLeft ? -1.0 : 1.0);

	FTripPose Out;
	Out.bMoving = Leg == 1 || Leg == 3;
	Out.X = P[Lo * 3] + (P[Hi * 3] - P[Lo * 3]) * F - Dy * Over; // to the right of the way it faces is (-dy, dx)
	Out.Y = P[Lo * 3 + 1] + (P[Hi * 3 + 1] - P[Lo * 3 + 1]) * F + Dx * Over;
	Out.Yaw = std::fmod((std::atan2(Dx, -Dy) * 180.0) / Pi + 360.0, 360.0);
	Out.Leg = Leg;
	Out.Pace = Out.bMoving && Span > 0.0 ? Run / Span : 0.0;
	Out.bInLane = Out.bMoving && G0 == 1.0 && G1 == 1.0;
	Out.Lift = LiftAt(Trip, Along);
	Out.Rolled = Driven;
	return Out;
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
		void Near(double Ours, double Theirs)
		{
			++Checks;
			Worst = FMath::Max(Worst, FMath::Abs(Ours - Theirs));
		}
		void NearAngle(double Ours, double Theirs)
		{
			++Checks;
			Worst = FMath::Max(Worst, FMath::Abs(FMath::FindDeltaAngleDegrees(Ours, Theirs)));
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
	FTally Hashes, Creatures, Calls, Cars, Trains;

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

	const auto Report = [](const TCHAR* What, const FTally& Tally)
	{
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: life test: %s: %d checks, %d wrong, largest difference %.3g"), What, Tally.Checks, Tally.Wrong, Tally.Worst);
		return Tally.Checks > 0 && Tally.Wrong == 0 && Tally.Worst < 1e-6;
	};
	// Not short-circuited: every line is wanted in the log.
	const bool bHashes = Report(TEXT("hashes"), Hashes);
	const bool bCreatures = Report(TEXT("animals"), Creatures);
	const bool bCalls = Report(TEXT("calls"), Calls);
	const bool bCars = Report(TEXT("cars"), Cars);
	const bool bTrains = Report(TEXT("trains"), Trains);
	const bool bOk = bHashes && bCreatures && bCalls && bCars && bTrains;
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: life test: %s"), bOk ? TEXT("PASSED, the same answers as the browser") : TEXT("FAILED"));
	return bOk;
}
