#include "EarthIdleMoves.h"

#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

bool EarthIdle::bQuiet = false;

namespace
{
	constexpr double IdleAfterS = 30.0;
	constexpr double CycleS = 9.0;
	constexpr double SayFromS = 0.4;
	constexpr double SayForS = 5.2;
	constexpr float Tau = UE_TWO_PI;

	/** How long each fidget takes: wave, dance, spin, stretch, hops, foot, nod, tail. */
	const float FidgetSeconds[] = { 3.2f, 4.6f, 2.6f, 4.f, 2.4f, 3.6f, 5.f, 3.f };

	const TCHAR* const Mutters[] = {
		TEXT("I wonder what clouds taste like."),
		TEXT("Left foot, right foot... which one was next?"),
		TEXT("La la la, la-la la..."),
		TEXT("If I stand very still, am I a statue?"),
		TEXT("Did that tree just wink at me?"),
		TEXT("I spy, with my little eye... everything!"),
		TEXT("Is it lunchtime yet?"),
		TEXT("One day I shall walk all the way round the world."),
		TEXT("Hello, toes. Still there? Good."),
		TEXT("What is the hurry? That is what the snail says."),
		TEXT("Hmm hm hmm, hm hmm..."),
		TEXT("I bet I could hop to the moon. Almost."),
	};

	/** From 0 to 1, gently at both ends. */
	float Glide(float U)
	{
		const float X = FMath::Clamp(U, 0.f, 1.f);
		return X * X * (3.f - 2.f * X);
	}
	/** Up from nothing and back to nothing over a fidget: 0 at both ends, and 1 for the middle three fifths. */
	float Swell(float U) { return Glide(U / 0.2f) * Glide((1.f - U) / 0.2f); }

	double IdleAfter()
	{
		static const double After = []() { double Value = IdleAfterS; FParse::Value(FCommandLine::Get(), TEXT("-EWIdleAfter="), Value); return FMath::Max(1.0, Value); }();
		return After;
	}
}

const TCHAR* EarthIdle::Mutter(int32 Index)
{
	return Index >= 0 && Index < UE_ARRAY_COUNT(Mutters) ? Mutters[Index] : TEXT("");
}

uint32 EarthIdle::SeedOf(const FString& Text)
{
	uint32 H = 2166136261u;
	for (const TCHAR Ch : Text)
	{
		H = (H ^ static_cast<uint32>(Ch)) * 16777619u;
	}
	return H;
}

bool EarthIdle::At(double Still, uint32 Seed, FNow& Out)
{
	if (!(Still >= IdleAfter()))
	{
		return false;
	}
	const double Since = Still - IdleAfter();
	const int32 N = FMath::FloorToInt32(Since / CycleS);
	const double T = Since - N * CycleS;
	static const uint32 Steps[] = { 1, 3, 5, 7 }; // each is coprime with the eight fidgets
	const uint64 Step = Steps[(Seed >> 8) % 4];
	Out.N = N;
	Out.Fidget = static_cast<int32>((static_cast<uint64>(Seed) + static_cast<uint64>(N) * Step) % UE_ARRAY_COUNT(FidgetSeconds));
	Out.U = T < FidgetSeconds[Out.Fidget] ? static_cast<float>(T / FidgetSeconds[Out.Fidget]) : -1.f;
	const bool bSpeaks = N % 2 == 0 && T >= SayFromS && T < SayFromS + SayForS;
	Out.Say = bSpeaks ? static_cast<int32>((static_cast<uint64>(Seed >> 3) + static_cast<uint64>(N / 2) * 7) % UE_ARRAY_COUNT(Mutters)) : -1;
	return true;
}

void EarthIdle::Pose(int32 Fidget, float U, FEarthFidget& P)
{
	P = FEarthFidget();
	if (U < 0.f)
	{
		return;
	}
	const float E = Swell(U);
	switch (Fidget)
	{
	case 0: // a wave
		P.ArmOut[1] = E * (2.3f + 0.35f * FMath::Sin(U * Tau * 5.f));
		P.HeadRoll = 0.16f * E;
		P.Lift = 0.02f * E * FMath::Abs(FMath::Sin(U * Tau * 2.5f));
		P.TailYaw = 0.5f * E * FMath::Sin(U * Tau * 5.f);
		break;
	case 1: // a little dance
	{
		const float Beat = FMath::Sin(U * Tau * 6.f);
		P.Roll = 0.18f * E * Beat;
		P.Lift = 0.06f * E * FMath::Abs(Beat);
		P.ArmOut[0] = E * (1.2f + 0.8f * Beat);
		P.ArmOut[1] = E * (1.2f - 0.8f * Beat);
		P.Twist = 0.35f * E * FMath::Sin(U * Tau * 3.f);
		P.HeadRoll = -0.2f * E * Beat;
		P.TailYaw = 0.8f * E * FMath::Sin(U * Tau * 12.f);
		P.FootLift[0] = 0.08f * E * FMath::Max(0.f, Beat);
		P.FootLift[1] = 0.08f * E * FMath::Max(0.f, -Beat);
		break;
	}
	case 2: // a spin
		P.Spin = Tau * 2.f * Glide(U);
		P.ArmOut[0] = P.ArmOut[1] = 1.4f * E;
		P.Lift = 0.05f * E;
		P.TailUp = 0.5f * E;
		break;
	case 3: // a stretch
		P.ArmOut[0] = P.ArmOut[1] = 2.6f * E;
		P.Squash = 0.12f * E;
		P.HeadPitch = -0.5f * E;
		P.Pitch = -0.08f * E;
		P.TailUp = 0.3f * E;
		break;
	case 4: // a few hops
	{
		const float Up = FMath::Abs(FMath::Sin(U * UE_PI * 3.f));
		P.Lift = 0.28f * Up * E;
		P.Squash = (0.1f * Up - 0.08f * (1.f - Up)) * E;
		P.ArmOut[0] = P.ArmOut[1] = 0.9f * Up * E;
		P.FootSwing[0] = P.FootSwing[1] = -0.4f * Up * E;
		P.TailUp = 0.5f * Up * E;
		break;
	}
	case 5: // a look at its own foot
		P.FootLift[1] = 0.22f * E;
		P.FootSwing[1] = 0.5f * E;
		P.HeadPitch = 0.7f * E;
		P.HeadYaw = 0.25f * E;
		P.Pitch = 0.15f * E;
		P.Roll = -0.08f * E;
		P.ArmOut[0] = 0.9f * E;
		P.FootSwing[0] = 0.1f * E * FMath::Sin(U * Tau * 4.f); // wobbling on the other one
		break;
	case 6: // nodding off: the head sinks for three quarters of it, then comes up with a start
	{
		const float Sink = Glide(U / 0.74f);
		const float Start = U < 0.76f ? 0.f : Swell((U - 0.76f) / 0.24f);
		const float Down = U < 0.76f ? Sink : 1.f - Glide((U - 0.76f) / 0.06f);
		P.HeadPitch = 0.78f * Down - 0.25f * Start;
		P.Pitch = 0.1f * Down;
		P.Squash = -0.05f * Down + 0.06f * Start;
		P.HeadRoll = 0.12f * Down;
		P.Lift = 0.09f * Start;
		P.ArmOut[0] = P.ArmOut[1] = 0.8f * Start;
		break;
	}
	case 7: // chasing its tail
		P.Spin = -Tau * 3.f * Glide(U);
		P.Pitch = 0.25f * E;
		P.HeadYaw = -0.6f * E;
		P.TailYaw = 0.9f * E * FMath::Sin(U * Tau * 6.f);
		P.TailUp = 0.4f * E;
		break;
	default:
		break;
	}
}
