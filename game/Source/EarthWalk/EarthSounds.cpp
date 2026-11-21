#include "EarthSounds.h"

#include "Components/AudioComponent.h"
#include "GameFramework/Actor.h"
#include "HAL/PlatformTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Sound/SoundWaveProcedural.h"

#include <cmath>

namespace
{
	constexpr int32 MaxVoices = 6;
	constexpr double Rate = UEarthSounds::SampleRate;
	constexpr double TwoPi = 6.283185307179586;

	// ---- the same building blocks as the browser's Web Audio graph (sounds.js, `note`)

	enum class EWave : uint8 { Saw, Square, Triangle, Sine };
	enum class EFilter : uint8 { LowPass, BandPass, Peaking };

	/** A value at a moment: seconds since the note began, and the pitch, loudness or filter frequency then. */
	struct FPoint
	{
		double At;
		double Value;
	};

	struct FFilter
	{
		EFilter Kind;
		double Hz;
		double Q;
		TArray<FPoint> Sweep; // where the frequency glides to afterwards
	};

	/** One note: an oscillator whose pitch and loudness follow the given points. */
	struct FNote
	{
		EWave Type = EWave::Saw;
		TArray<FPoint> Pitch; // glides from each to the next, evenly in pitch
		TArray<FPoint> Level; // ramps from silence through each in turn
		TArray<FFilter> Chain;
		double VibratoHz = 0.0; // a wobble of the pitch, this many hertz either way
		double VibratoDepth = 0.0;
		double TremoloHz = 0.0; // a wobble of the loudness, by this share of it
		double TremoloDepth = 0.0;
	};

	/** Between points the value glides by equal ratios (as a pitch does); after the last it stays. */
	double Glide(const TArray<FPoint>& Points, double At)
	{
		for (int32 i = 1; i < Points.Num(); ++i)
		{
			if (At < Points[i].At)
			{
				const FPoint& A = Points[i - 1];
				const FPoint& B = Points[i];
				return A.Value * std::pow(B.Value / A.Value, (At - A.At) / FMath::Max(B.At - A.At, 1e-9));
			}
		}
		return Points.Last().Value;
	}

	/** Loudness: straight lines from silence at the start through each point. */
	double Ramp(const TArray<FPoint>& Points, double At)
	{
		double FromAt = 0.0, From = 0.0;
		for (const FPoint& Point : Points)
		{
			if (At < Point.At)
			{
				return From + (Point.Value - From) * (At - FromAt) / FMath::Max(Point.At - FromAt, 1e-9);
			}
			FromAt = Point.At;
			From = Point.Value;
		}
		return From;
	}

	/** Rounds off the jump in a sawtooth or square wave, which would otherwise ring at pitches that are not there. */
	double Blep(double Phase, double Step)
	{
		if (Phase < Step)
		{
			const double X = Phase / Step;
			return X + X - X * X - 1.0;
		}
		if (Phase > 1.0 - Step)
		{
			const double X = (Phase - 1.0) / Step;
			return X * X + X + X + 1.0;
		}
		return 0.0;
	}

	/** A two-pole filter with the Web Audio API's own formulas, so the voices come out the same. */
	struct FBiquad
	{
		double B0 = 1.0, B1 = 0.0, B2 = 0.0, A1 = 0.0, A2 = 0.0;
		double X1 = 0.0, X2 = 0.0, Y1 = 0.0, Y2 = 0.0;

		void Set(EFilter Kind, double Hz, double Q)
		{
			const double W = TwoPi * FMath::Clamp(Hz, 10.0, Rate * 0.49) / Rate;
			const double Cos = std::cos(W);
			const double Sin = std::sin(W);
			double A0 = 1.0;
			if (Kind == EFilter::LowPass)
			{
				// For a low-pass filter the Web Audio API reads Q as decibels of resonance.
				const double Alpha = Sin / (2.0 * std::pow(10.0, Q / 20.0));
				A0 = 1.0 + Alpha;
				B0 = (1.0 - Cos) / 2.0 / A0;
				B1 = (1.0 - Cos) / A0;
				B2 = B0;
				A1 = -2.0 * Cos / A0;
				A2 = (1.0 - Alpha) / A0;
			}
			else if (Kind == EFilter::BandPass)
			{
				const double Alpha = Sin / (2.0 * FMath::Max(Q, 0.01));
				A0 = 1.0 + Alpha;
				B0 = Alpha / A0;
				B1 = 0.0;
				B2 = -Alpha / A0;
				A1 = -2.0 * Cos / A0;
				A2 = (1.0 - Alpha) / A0;
			}
			// A peaking filter with no gain set, as sounds.js leaves it, lets everything through unchanged.
		}

		double Run(double X)
		{
			const double Y = B0 * X + B1 * X1 + B2 * X2 - A1 * Y1 - A2 * Y2;
			X2 = X1;
			X1 = X;
			Y2 = Y1;
			Y1 = Y;
			return Y;
		}
	};

	void AddNote(TArray<double>& Mix, double Start, const FNote& Note)
	{
		const double Length = Note.Level.Last().At;
		const int32 First = FMath::RoundToInt32(Start * Rate);
		const int32 Count = FMath::CeilToInt32(Length * Rate);
		if (Mix.Num() < First + Count)
		{
			Mix.SetNumZeroed(First + Count);
		}
		TArray<FBiquad> Filters;
		TArray<TArray<FPoint>> Sweeps;
		for (const FFilter& Filter : Note.Chain)
		{
			Filters.AddDefaulted_GetRef().Set(Filter.Kind, Filter.Hz, Filter.Q);
			TArray<FPoint>& Sweep = Sweeps.AddDefaulted_GetRef();
			Sweep.Add({ 0.0, Filter.Hz });
			Sweep.Append(Filter.Sweep);
		}
		double Phase = 0.0;
		for (int32 i = 0; i < Count; ++i)
		{
			const double At = i / Rate;
			double Hz = Glide(Note.Pitch, At);
			if (Note.VibratoHz > 0.0)
			{
				Hz += Note.VibratoDepth * std::sin(TwoPi * Note.VibratoHz * At);
			}
			const double Step = FMath::Clamp(Hz / Rate, 0.0, 0.45);
			double Sample;
			switch (Note.Type)
			{
			case EWave::Square:
				Sample = (Phase < 0.5 ? 1.0 : -1.0) + Blep(Phase, Step) - Blep(std::fmod(Phase + 0.5, 1.0), Step);
				break;
			case EWave::Triangle:
				Sample = Phase < 0.25 ? 4.0 * Phase : Phase < 0.75 ? 2.0 - 4.0 * Phase : 4.0 * Phase - 4.0;
				break;
			case EWave::Sine:
				Sample = std::sin(TwoPi * Phase);
				break;
			default:
			{
				// Rises through nought at the start of each turn and drops back half way round.
				const double Shifted = std::fmod(Phase + 0.5, 1.0);
				Sample = 2.0 * Shifted - 1.0 - Blep(Shifted, Step);
				break;
			}
			}
			Phase += Step;
			Phase -= std::floor(Phase);

			for (int32 f = 0; f < Filters.Num(); ++f)
			{
				if (Sweeps[f].Num() > 1 && (i & 15) == 0)
				{
					Filters[f].Set(Note.Chain[f].Kind, Glide(Sweeps[f], At), Note.Chain[f].Q);
				}
				Sample = Filters[f].Run(Sample);
			}
			if (Note.TremoloHz > 0.0)
			{
				Sample *= 1.0 - Note.TremoloDepth / 2.0 + (Note.TremoloDepth / 2.0) * std::sin(TwoPi * Note.TremoloHz * At);
			}
			Mix[First + i] += Sample * Ramp(Note.Level, At);
		}
	}

	void Cluck(TArray<double>& Mix, double Start, double P, double Level = 0.8)
	{
		FNote Note;
		Note.Type = EWave::Square;
		Note.Pitch = { { 0, 430 * P }, { 0.03, 840 * P }, { 0.08, 500 * P } };
		Note.Level = { { 0.008, Level }, { 0.09, 0 } };
		Note.Chain = { { EFilter::BandPass, 1000 * P, 2, {} } };
		AddNote(Mix, Start, Note);
	}

	/** How loud each call is against the others. */
	double Loudness(const FString& Kind)
	{
		static const TMap<FString, double> Table = {
			{ TEXT("moo"), 1.0 }, { TEXT("baa"), 0.7 }, { TEXT("neigh"), 0.8 }, { TEXT("cluck"), 0.3 }, { TEXT("squawk"), 0.45 },
			{ TEXT("quack"), 0.4 }, { TEXT("coo"), 0.3 }, { TEXT("caw"), 0.9 }, { TEXT("woof"), 0.7 }, { TEXT("meow"), 0.45 },
			{ TEXT("bray"), 0.5 }, { TEXT("toot"), 0.5 }, { TEXT("chug"), 0.45 }, { TEXT("whistle"), 0.9 },
			{ TEXT("oink"), 0.5 }, { TEXT("honk"), 0.6 }, { TEXT("squeak"), 0.25 }, { TEXT("ribbit"), 0.4 }, { TEXT("buzz"), 0.15 },
			{ TEXT("cheep"), 0.25 }, { TEXT("trumpet"), 0.9 },
		};
		const double* Found = Table.Find(Kind);
		return Found ? *Found : 0.0;
	}

	/** Each voice lays down its notes; the recipes are VOICES in sounds.js. */
	bool Compose(const FString& Kind, double P, TArray<double>& Mix)
	{
		if (Kind == TEXT("moo"))
		{
			// "Mmm-ooo": a low buzz that opens up and sinks away.
			FNote Note;
			Note.Pitch = { { 0, 96 * P }, { 0.18, 150 * P }, { 0.9, 136 * P }, { 1.6, 100 * P } };
			Note.Level = { { 0.12, 0.9 }, { 1.1, 0.8 }, { 1.6, 0 } };
			Note.VibratoHz = 5.5;
			Note.VibratoDepth = 3;
			Note.Chain = { { EFilter::LowPass, 340, 3, { { 0.3, 900 }, { 1.6, 480 } } }, { EFilter::Peaking, 620, 2, {} } };
			AddNote(Mix, 0, Note);
		}
		else if (Kind == TEXT("baa"))
		{
			// A quavering "baa".
			FNote Note;
			Note.Pitch = { { 0, 335 * P }, { 0.75, 300 * P } };
			Note.Level = { { 0.04, 0.9 }, { 0.55, 0.8 }, { 0.78, 0 } };
			Note.VibratoHz = 8;
			Note.VibratoDepth = 12;
			Note.TremoloHz = 8;
			Note.TremoloDepth = 0.9;
			Note.Chain = { { EFilter::BandPass, 950, 1.2, {} }, { EFilter::LowPass, 2600, 0.7, {} } };
			AddNote(Mix, 0, Note);
		}
		else if (Kind == TEXT("neigh"))
		{
			// A whinny: up fast, then tumbling down with a shake in it.
			FNote Note;
			Note.Pitch = { { 0, 520 * P }, { 0.12, 1150 * P }, { 0.45, 900 * P }, { 1.1, 420 * P } };
			Note.Level = { { 0.05, 0.8 }, { 0.6, 0.7 }, { 1.15, 0 } };
			Note.VibratoHz = 13;
			Note.VibratoDepth = 70;
			Note.TremoloHz = 13;
			Note.TremoloDepth = 0.6;
			Note.Chain = { { EFilter::BandPass, 1400, 1, {} } };
			AddNote(Mix, 0, Note);
		}
		else if (Kind == TEXT("cluck"))
		{
			Cluck(Mix, 0, P);
			Cluck(Mix, 0.14, P * 1.06);
			Cluck(Mix, 0.3, P * 0.97);
		}
		else if (Kind == TEXT("squawk"))
		{
			// A startled hen: one long squawk, then indignant clucking.
			FNote Note;
			Note.Type = EWave::Square;
			Note.Pitch = { { 0, 620 * P }, { 0.08, 1300 * P }, { 0.28, 720 * P } };
			Note.Level = { { 0.01, 0.9 }, { 0.2, 0.7 }, { 0.3, 0 } };
			Note.TremoloHz = 32;
			Note.TremoloDepth = 0.8;
			Note.Chain = { { EFilter::BandPass, 1300 * P, 1.5, {} } };
			AddNote(Mix, 0, Note);
			for (int32 i = 0; i < 4; ++i)
			{
				Cluck(Mix, 0.36 + i * 0.11, P * (1.1 - i * 0.04), 0.7);
			}
		}
		else if (Kind == TEXT("quack"))
		{
			// A duck: three nasal quacks, each a little lower.
			for (int32 i = 0; i < 3; ++i)
			{
				FNote Note;
				Note.Pitch = { { 0, 460 * P * (1 - i * 0.05) }, { 0.15, 330 * P } };
				Note.Level = { { 0.015, 0.9 }, { 0.1, 0.7 }, { 0.17, 0 } };
				Note.Chain = { { EFilter::BandPass, 1350, 3, {} }, { EFilter::LowPass, 3000, 0.7, {} } };
				AddNote(Mix, i * 0.21, Note);
			}
		}
		else if (Kind == TEXT("coo"))
		{
			// A pigeon: a soft, round "coo-COO-coo".
			const auto Say = [&Mix, P](double At, double Hz, double Long, double Loud)
			{
				FNote Note;
				Note.Type = EWave::Triangle;
				Note.Pitch = { { 0, Hz * P * 0.94 }, { Long * 0.4, Hz * P }, { Long, Hz * P * 0.9 } };
				Note.Level = { { 0.05, Loud }, { Long * 0.7, Loud * 0.8 }, { Long, 0 } };
				Note.TremoloHz = 22;
				Note.TremoloDepth = 0.35;
				Note.Chain = { { EFilter::LowPass, 900, 0.7, {} } };
				AddNote(Mix, At, Note);
			};
			Say(0, 400, 0.22, 0.6);
			Say(0.28, 470, 0.42, 0.9);
			Say(0.76, 390, 0.26, 0.6);
		}
		else if (Kind == TEXT("caw"))
		{
			// A gull crying overhead: two falling calls.
			for (int32 i = 0; i < 2; ++i)
			{
				FNote Note;
				Note.Pitch = { { 0, 950 * P }, { 0.08, 1500 * P }, { 0.4, 820 * P } };
				Note.Level = { { 0.03, 0.8 }, { 0.25, 0.6 }, { 0.42, 0 } };
				Note.VibratoHz = 9;
				Note.VibratoDepth = 30;
				Note.Chain = { { EFilter::BandPass, 1900, 1.5, {} } };
				AddNote(Mix, i * 0.5, Note);
			}
		}
		else if (Kind == TEXT("woof"))
		{
			// A dog: two short, friendly barks.
			for (int32 i = 0; i < 2; ++i)
			{
				FNote Note;
				Note.Pitch = { { 0, 210 * P }, { 0.04, 290 * P }, { 0.16, 130 * P } };
				Note.Level = { { 0.01, 1 }, { 0.08, 0.7 }, { 0.18, 0 } };
				Note.Chain = { { EFilter::LowPass, 1100, 2, { { 0.16, 500 } } }, { EFilter::Peaking, 520, 2, {} } };
				AddNote(Mix, i * 0.26, Note);
			}
		}
		else if (Kind == TEXT("meow"))
		{
			// A cat: "mee-ow", up and then down, with the mouth opening and closing.
			FNote Note;
			Note.Pitch = { { 0, 520 * P }, { 0.22, 820 * P }, { 0.7, 470 * P } };
			Note.Level = { { 0.06, 0.8 }, { 0.45, 0.7 }, { 0.72, 0 } };
			Note.VibratoHz = 6;
			Note.VibratoDepth = 8;
			Note.Chain = { { EFilter::BandPass, 900, 2, { { 0.25, 1900 }, { 0.7, 950 } } } };
			AddNote(Mix, 0, Note);
		}
		else if (Kind == TEXT("bray"))
		{
			// A penguin: a hoarse, donkey-like bray.
			for (int32 i = 0; i < 3; ++i)
			{
				FNote Note;
				Note.Pitch = { { 0, 300 * P }, { 0.1, 380 * P }, { 0.26, 280 * P } };
				Note.Level = { { 0.03, 0.8 }, { 0.2, 0.6 }, { 0.28, 0 } };
				Note.TremoloHz = 26;
				Note.TremoloDepth = 0.8;
				Note.Chain = { { EFilter::BandPass, 950, 1.5, {} } };
				AddNote(Mix, i * 0.3, Note);
			}
		}
		else if (Kind == TEXT("toot"))
		{
			// A car horn: two notes at once, a short friendly "beep".
			for (const double Hz : { 392.0, 494.0 })
			{
				FNote Note;
				Note.Type = EWave::Square;
				Note.Pitch = { { 0, Hz * P }, { 0.3, Hz * P } };
				Note.Level = { { 0.015, 0.5 }, { 0.26, 0.5 }, { 0.3, 0 } };
				Note.Chain = { { EFilter::LowPass, 1900, 0.7, {} } };
				AddNote(Mix, 0, Note);
			}
		}
		else if (Kind == TEXT("chug"))
		{
			// A tractor's engine: a handful of low putts.
			for (int32 i = 0; i < 6; ++i)
			{
				FNote Note;
				Note.Pitch = { { 0, 78 * P }, { 0.09, 58 * P } };
				Note.Level = { { 0.01, 0.9 }, { 0.07, 0.5 }, { 0.11, 0 } };
				Note.Chain = { { EFilter::LowPass, 420, 1.5, {} } };
				AddNote(Mix, i * 0.14, Note);
			}
		}
		else if (Kind == TEXT("whistle"))
		{
			// A train: two long notes together, twice.
			for (int32 i = 0; i < 2; ++i)
			{
				for (const double Hz : { 587.0, 740.0 })
				{
					FNote Note;
					Note.Type = EWave::Triangle;
					Note.Pitch = { { 0, Hz * P * 0.97 }, { 0.08, Hz * P }, { 0.6, Hz * P * 0.99 } };
					Note.Level = { { 0.04, 0.6 }, { 0.5, 0.55 }, { 0.62, 0 } };
					Note.VibratoHz = 6;
					Note.VibratoDepth = 5;
					Note.Chain = { { EFilter::LowPass, 2600, 0.7, {} } };
					AddNote(Mix, i * 0.75, Note);
				}
			}
		}
		else if (Kind == TEXT("oink"))
		{
			// A snuffly "oink, oink".
			const double Starts[] = { 0.0, 0.26 };
			const double Raised[] = { 1.0, 1.12 };
			for (int32 i = 0; i < 2; ++i)
			{
				const double F = Raised[i];
				FNote Note;
				Note.Pitch = { { 0, 210 * P * F }, { 0.08, 150 * P * F }, { 0.2, 120 * P * F } };
				Note.Level = { { 0.02, 0.8 }, { 0.14, 0.6 }, { 0.2, 0 } };
				Note.TremoloHz = 38;
				Note.TremoloDepth = 0.7;
				Note.Chain = { { EFilter::BandPass, 700, 1.5, {} } };
				AddNote(Mix, Starts[i], Note);
			}
		}
		else if (Kind == TEXT("honk"))
		{
			// A goose: two nasal notes, the second a little lower.
			const double Starts[] = { 0.0, 0.3 };
			const double Raised[] = { 1.0, 0.9 };
			for (int32 i = 0; i < 2; ++i)
			{
				const double F = Raised[i];
				FNote Note;
				Note.Pitch = { { 0, 430 * P * F }, { 0.05, 470 * P * F }, { 0.22, 400 * P * F } };
				Note.Level = { { 0.02, 0.8 }, { 0.18, 0.7 }, { 0.25, 0 } };
				Note.Chain = { { EFilter::BandPass, 1150, 2, {} }, { EFilter::LowPass, 2600, 0.7, {} } };
				AddNote(Mix, Starts[i], Note);
			}
		}
		else if (Kind == TEXT("squeak"))
		{
			// A mouse: two tiny rising squeaks.
			for (const double At : { 0.0, 0.16 })
			{
				FNote Note;
				Note.Type = EWave::Sine;
				Note.Pitch = { { 0, 2400 * P }, { 0.06, 3300 * P }, { 0.11, 2700 * P } };
				Note.Level = { { 0.01, 0.7 }, { 0.08, 0.5 }, { 0.11, 0 } };
				AddNote(Mix, At, Note);
			}
		}
		else if (Kind == TEXT("ribbit"))
		{
			// A frog: "rib-bit", two croaks that slide up.
			const double Starts[] = { 0.0, 0.2 };
			const double Raised[] = { 1.0, 1.25 };
			for (int32 i = 0; i < 2; ++i)
			{
				const double F = Raised[i];
				FNote Note;
				Note.Pitch = { { 0, 170 * P * F }, { 0.14, 330 * P * F } };
				Note.Level = { { 0.02, 0.8 }, { 0.11, 0.7 }, { 0.16, 0 } };
				Note.TremoloHz = 46;
				Note.TremoloDepth = 0.9;
				Note.Chain = { { EFilter::BandPass, 900, 1.2, {} } };
				AddNote(Mix, Starts[i], Note);
			}
		}
		else if (Kind == TEXT("buzz"))
		{
			// A bee going by.
			FNote Note;
			Note.Pitch = { { 0, 185 * P }, { 0.35, 215 * P }, { 0.8, 180 * P } };
			Note.Level = { { 0.15, 0.7 }, { 0.6, 0.6 }, { 0.8, 0 } };
			Note.TremoloHz = 28;
			Note.TremoloDepth = 0.6;
			Note.Chain = { { EFilter::LowPass, 1100, 1, {} } };
			AddNote(Mix, 0, Note);
		}
		else if (Kind == TEXT("cheep"))
		{
			// A sparrow: three quick chirps.
			const double Starts[] = { 0.0, 0.12, 0.24 };
			const double Raised[] = { 1.0, 1.08, 0.96 };
			for (int32 i = 0; i < 3; ++i)
			{
				const double F = Raised[i];
				FNote Note;
				Note.Type = EWave::Sine;
				Note.Pitch = { { 0, 3200 * P * F }, { 0.04, 4300 * P * F }, { 0.08, 3000 * P * F } };
				Note.Level = { { 0.01, 0.7 }, { 0.06, 0.5 }, { 0.08, 0 } };
				AddNote(Mix, Starts[i], Note);
			}
		}
		else if (Kind == TEXT("trumpet"))
		{
			// An elephant: a brassy note that leaps up and sags.
			FNote Note;
			Note.Pitch = { { 0, 330 * P }, { 0.15, 640 * P }, { 0.7, 580 * P }, { 1.0, 380 * P } };
			Note.Level = { { 0.05, 0.9 }, { 0.7, 0.8 }, { 1.0, 0 } };
			Note.VibratoHz = 9;
			Note.VibratoDepth = 22;
			Note.Chain = { { EFilter::BandPass, 1200, 1, {} }, { EFilter::LowPass, 3200, 0.7, {} } };
			AddNote(Mix, 0, Note);
		}
		else
		{
			return false;
		}
		return true;
	}
}

bool UEarthSounds::Synthesise(const FString& Kind, double Pitch, TArray<int16>& Out)
{
	TArray<double> Mix;
	if (!Compose(Kind, Pitch, Mix))
	{
		return false;
	}
	// A short tail of silence, so the last sample is never cut off mid-swing.
	Mix.AddZeroed(SampleRate / 50);
	// Each voice keeps its place against the others (a moo is louder than a cluck), but the quiet ones
	// are brought up as far as there is room, as the browser's compressor does for them.
	double Peak = 0.0;
	for (const double Sample : Mix)
	{
		Peak = FMath::Max(Peak, FMath::Abs(Sample));
	}
	const double Loud = Loudness(Kind);
	const double Gain = Peak > 0.0 ? Loud * FMath::Min(1.7, 0.9 / (Peak * Loud)) : 0.0;
	Out.SetNumUninitialized(Mix.Num());
	for (int32 i = 0; i < Mix.Num(); ++i)
	{
		// Loud moments are rounded off rather than clipped.
		double Sample = Mix[i] * Gain;
		const double Size = FMath::Abs(Sample);
		if (Size > 0.7)
		{
			Sample = FMath::Sign(Sample) * (0.7 + 0.3 * std::tanh((Size - 0.7) / 0.3));
		}
		Out[i] = static_cast<int16>(FMath::RoundToInt32(Sample * 32000.0));
	}
	return true;
}

bool UEarthSounds::WriteWavFiles(const FString& Folder)
{
	bool bAll = true;
	for (const TCHAR* Kind : { TEXT("moo"), TEXT("baa"), TEXT("neigh"), TEXT("cluck"), TEXT("squawk"), TEXT("quack"), TEXT("coo"), TEXT("caw"),
		TEXT("woof"), TEXT("meow"), TEXT("bray"), TEXT("toot"), TEXT("chug"), TEXT("whistle"),
		TEXT("oink"), TEXT("honk"), TEXT("squeak"), TEXT("ribbit"), TEXT("buzz"), TEXT("cheep"), TEXT("trumpet") })
	{
		TArray<int16> Samples;
		Synthesise(Kind, 1.0, Samples);
		const int32 DataBytes = Samples.Num() * 2;
		TArray<uint8> File;
		const auto Text = [&File](const char* Four) { File.Append(reinterpret_cast<const uint8*>(Four), 4); };
		const auto U32 = [&File](uint32 Value) { File.Append(reinterpret_cast<const uint8*>(&Value), 4); };
		const auto U16 = [&File](uint16 Value) { File.Append(reinterpret_cast<const uint8*>(&Value), 2); };
		Text("RIFF");
		U32(36 + DataBytes);
		Text("WAVE");
		Text("fmt ");
		U32(16);
		U16(1); // plain samples
		U16(1); // one channel
		U32(SampleRate);
		U32(SampleRate * 2);
		U16(2);
		U16(16);
		Text("data");
		U32(DataBytes);
		File.Append(reinterpret_cast<const uint8*>(Samples.GetData()), DataBytes);
		bAll &= FFileHelper::SaveArrayToFile(File, *FPaths::Combine(Folder, FString(Kind) + TEXT(".wav")));
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: sounds: %s the voices as .wav files in %s"), bAll ? TEXT("wrote") : TEXT("could NOT write all of"), *Folder);
	return bAll;
}

void UEarthSounds::Setup(AActor* Owner)
{
	if (!Owner || Players.Num() > 0)
	{
		return;
	}
	for (int32 i = 0; i < MaxVoices; ++i)
	{
		UAudioComponent* Player = NewObject<UAudioComponent>(Owner);
		Player->bAutoActivate = false;
		Player->bAutoDestroy = false;
		Player->bAllowSpatialization = true;
		// The sound comes from where the animal is; how loud it is with distance is worked out here,
		// with the browser's own rule, when the call starts.
		Player->bOverrideAttenuation = true;
		Player->AttenuationOverrides.bAttenuate = false;
		Player->AttenuationOverrides.bSpatialize = true;
		Player->SetupAttachment(Owner->GetRootComponent());
		Player->RegisterComponent();
		Players.Add(Player);
		Waves.Add(nullptr);
		Voices.AddDefaulted();
	}
}

void UEarthSounds::SetEnabled(bool bOn)
{
	bEnabled = bOn;
	if (!bOn)
	{
		for (int32 i = 0; i < Players.Num(); ++i)
		{
			if (Players[i])
			{
				Players[i]->Stop();
			}
			Voices[i].bBusy = false;
		}
	}
}

void UEarthSounds::Tick()
{
	const double Now = FPlatformTime::Seconds();
	for (int32 i = 0; i < Voices.Num(); ++i)
	{
		if (Voices[i].bBusy && Now > Voices[i].Until)
		{
			Voices[i].bBusy = false;
			if (Players[i])
			{
				Players[i]->Stop();
			}
			Waves[i] = nullptr;
		}
	}
}

bool UEarthSounds::Play(const TCHAR* Kind, const FVector& Where, double Pitch, const FVector& Ears)
{
	if (!bEnabled || !Kind)
	{
		return false;
	}
	int32 Free = INDEX_NONE;
	for (int32 i = 0; i < Voices.Num(); ++i)
	{
		if (!Voices[i].bBusy && Players[i])
		{
			Free = i;
			break;
		}
	}
	if (Free == INDEX_NONE)
	{
		return false;
	}
	// Voices a fiftieth apart in pitch sound the same, so they share a wave.
	const int32 Step = FMath::RoundToInt32(FMath::Clamp(Pitch, 0.5, 2.0) * 50.0);
	const FString Key = FString::Printf(TEXT("%s %d"), Kind, Step);
	TArray<int16>* Samples = Cache.Find(Key);
	if (!Samples)
	{
		TArray<int16> Made;
		if (!Synthesise(Kind, Step / 50.0, Made))
		{
			return false;
		}
		Samples = &Cache.Add(Key, MoveTemp(Made));
	}

	// Quieter with distance, as the browser's panner has it: full within 5 m, then falling away.
	const double Metres = FMath::Min(FVector::Dist(Where, Ears) / 100.0, 300.0);
	const double Gain = 5.0 / (5.0 + 1.5 * (FMath::Max(Metres, 5.0) - 5.0));

	USoundWaveProcedural* Wave = NewObject<USoundWaveProcedural>(this);
	Wave->SetSampleRate(SampleRate);
	Wave->NumChannels = 1;
	Wave->Duration = INDEFINITELY_LOOPING_DURATION;
	Wave->SoundGroup = SOUNDGROUP_Default;
	Wave->bLooping = false;
	Wave->QueueAudio(reinterpret_cast<const uint8*>(Samples->GetData()), Samples->Num() * sizeof(int16));
	Waves[Free] = Wave;

	UAudioComponent* Player = Players[Free];
	Player->SetWorldLocation(Where);
	Player->SetSound(Wave);
	Player->SetVolumeMultiplier(static_cast<float>(Gain));
	Player->Play();
	Voices[Free].bBusy = true;
	Voices[Free].Until = FPlatformTime::Seconds() + static_cast<double>(Samples->Num()) / SampleRate + 0.35;
	++Played;
	return true;
}
