#include "EarthFlight.h"

#include "EarthGeo.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWorld.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"

#include <cmath>

namespace
{
	// The numbers of server/public/js/flightplan.js and flight.js.
	constexpr int32 FlightLowSteps = 14;
	constexpr int32 FlightSeenChunks = 2;
	constexpr double FlightHighM = 3000.0;
	constexpr double FlightUpS = 14.0;
	constexpr double FlightDownS = 15.0;
	constexpr double FlightEndsM = 2000.0;
	constexpr double FlightTooNearM = 40.0;
	constexpr double FlightRoofClearM = 8.0; // a flight keeps this far above a roof it passes over
	constexpr double FlightAheadS = 3.0;     // and looks this many seconds ahead for hills and roofs
	constexpr double FlightNoteM = 8.0;      // how far along the way one note of the ground's height covers
	constexpr double FlightHeldOffM = 18000.0; // crossing in the haze the player is kept this near the place in the scene: far-off numbers draw badly
	const double FlightRings[] = { 0.0, 5.0, 9.0, 14.0, 20.0, 28.0, 38.0, 50.0, 65.0, 80.0 }; // where to look for clear ground beside the place

	double FlightSmooth(double U) { const double V = FMath::Clamp(U, 0.0, 1.0); return V * V * (3.0 - 2.0 * V); }
	double FlightSmoother(double U) { const double V = FMath::Clamp(U, 0.0, 1.0); return V * V * V * (V * (V * 6.0 - 15.0) + 10.0); }
	FVector FlightToEngine(double X, double Y, double Z) { return FVector(-Z * 100.0, X * 100.0, Y * 100.0); }
	const FLinearColor FlightNotice(0.75f, 0.9f, 1.f);
}

// ---------------------------------------------------------------- the sums

double EarthFlightSums::MetresBetween(double ALat, double ALon, double BLat, double BLon)
{
	const double Rad = UE_DOUBLE_PI / 180.0;
	const double DLat = (BLat - ALat) * Rad, DLon = (BLon - ALon) * Rad;
	const double H = FMath::Square(std::sin(DLat / 2.0)) + std::cos(ALat * Rad) * std::cos(BLat * Rad) * FMath::Square(std::sin(DLon / 2.0));
	return 2.0 * (EarthGeo::EarthCircumference / (2.0 * UE_DOUBLE_PI)) * std::asin(FMath::Min(1.0, std::sqrt(H)));
}

bool EarthFlightSums::Plan(double FromLat, double FromLon, double ToLat, double ToLon, FEarthFlightPlan& Out)
{
	const double Lat0 = FMath::Clamp(FromLat, -85.0, 85.0), Lat1 = FMath::Clamp(ToLat, -85.0, 85.0);
	Out = FEarthFlightPlan();
	Out.Metres = MetresBetween(Lat0, FromLon, Lat1, ToLon);
	if (!(Out.Metres >= FlightTooNearM))
	{
		return false;
	}
	Out.Fx = EarthGeo::LonToX(FromLon);
	Out.Fy = EarthGeo::LatToY(Lat0);
	Out.Dx = EarthGeo::LonToX(ToLon) - Out.Fx;
	if (Out.Dx > EarthGeo::TilesAcross / 2.0) { Out.Dx -= EarthGeo::TilesAcross; } // the shorter way round
	else if (Out.Dx < -EarthGeo::TilesAcross / 2.0) { Out.Dx += EarthGeo::TilesAcross; }
	Out.Dy = EarthGeo::LatToY(Lat1) - Out.Fy;
	Out.Steps = FMath::Abs(FMath::FloorToInt32(Out.Fx + Out.Dx) - FMath::FloorToInt32(Out.Fx)) + FMath::Abs(FMath::FloorToInt32(Out.Fy + Out.Dy) - FMath::FloorToInt32(Out.Fy));
	Out.ToLat = Lat1;
	Out.ToLon = ToLon;
	const int32 Wide = 2 * FlightSeenChunks + 1;
	Out.bLow = Out.Steps <= FlightLowSteps;
	if (Out.bLow)
	{
		Out.Seconds = FMath::Clamp(15.0 + 15.0 * std::log10(FMath::Max(1.0, Out.Metres) / 300.0), 8.0, 40.0);
		Out.Height = FMath::Clamp(40.0 + Out.Metres / 20.0, 60.0, 180.0);
		Out.Chunks = Wide * Out.Steps;
		return true;
	}
	Out.Ends = FMath::Min(FlightEndsM, Out.Metres * 0.35);
	Out.Up = FlightUpS;
	Out.Over = FMath::Clamp(5.0 + 8.0 * std::log10(FMath::Max(1.0, Out.Metres) / 10000.0), 5.0, 40.0);
	Out.Down = FlightDownS;
	Out.Seconds = Out.Up + Out.Over + Out.Down;
	Out.Height = FlightHighM;
	Out.Chunks = Wide * Wide;
	return true;
}

FString EarthFlightSums::FarWords(double Metres)
{
	if (Metres < 950.0)
	{
		return FString::Printf(TEXT("%d m"), FMath::Max(10, FMath::RoundToInt32(Metres / 10.0) * 10));
	}
	if (Metres < 99500.0)
	{
		return FString::Printf(TEXT("%.1f km"), Metres / 1000.0);
	}
	// Whole kilometres, with commas: "1,240 km".
	FString Digits = FString::Printf(TEXT("%d"), FMath::RoundToInt32(Metres / 1000.0));
	for (int32 i = Digits.Len() - 3; i > 0; i -= 3)
	{
		Digits.InsertAt(i, TEXT(","));
	}
	return Digits + TEXT(" km");
}

FString EarthFlightSums::TimeWords(double Seconds)
{
	if (Seconds < 25.0) { return FString::Printf(TEXT("about %d seconds"), FMath::Max(10, FMath::RoundToInt32(Seconds / 5.0) * 5)); }
	if (Seconds < 36.0) { return TEXT("about half a minute"); }
	if (Seconds < 52.0) { return TEXT("about three quarters of a minute"); }
	if (Seconds < 75.0) { return TEXT("about a minute"); }
	return FString::Printf(TEXT("about %s minutes"), *FString::SanitizeFloat(FMath::RoundToDouble(Seconds / 30.0) / 2.0, 0));
}

FString EarthFlightSums::ShortName(const FString& InName)
{
	const FString Whole = InName.TrimStartAndEnd();
	TArray<FString> Parts;
	Whole.ParseIntoArray(Parts, TEXT(","), true);
	TArray<FString> Kept;
	for (FString Part : Parts)
	{
		Part.TrimStartAndEndInline();
		bool bOnlyNumbers = true;
		for (const TCHAR C : Part)
		{
			bOnlyNumbers = bOnlyNumbers && (FChar::IsDigit(C) || C == TEXT(' ') || C == TEXT('.') || C == TEXT('-'));
		}
		if (!Part.IsEmpty() && !bOnlyNumbers) // house numbers and postcodes are left out
		{
			Kept.Add(Part);
		}
	}
	if (Kept.Num() == 0)
	{
		return Whole; // a name that is only numbers, a latitude and a longitude, stays as it is
	}
	return Kept.Num() > 2 ? Kept[0] + TEXT(", ") + Kept.Last() : FString::Join(Kept, TEXT(", "));
}

void EarthFlightSums::Check()
{
	struct FRow { const TCHAR* What; double ALat, ALon, BLat, BLon; };
	const FRow Rows[] = {
		{ TEXT("Devonport to Queens Wharf"), -36.8312, 174.7965, -36.8410, 174.7683 },
		{ TEXT("Queens Wharf to the Eiffel Tower"), -36.8410, 174.7683, 48.8582599, 2.2945006 },
		{ TEXT("Titirangi to Devonport"), -36.9379, 174.6563, -36.8312, 174.7965 },
		{ TEXT("Devonport to Wellington"), -36.8312, 174.7965, -41.2889, 174.7772 },
	};
	for (const FRow& Row : Rows)
	{
		FEarthFlightPlan P;
		Plan(Row.ALat, Row.ALon, Row.BLat, Row.BLon, P);
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: flight check: %s: %s, %.0f m, %.2f s (%.0f + %.2f + %.0f), height %.1f, steps %d, chunks %d, yaw %.1f; \"%s\", \"%s\""), Row.What,
			P.bLow ? TEXT("low") : TEXT("high"), P.Metres, P.Seconds, P.Up, P.Over, P.Down, P.Height, P.Steps, P.Chunks, FMath::RadiansToDegrees(std::atan2(P.Dx, -P.Dy)), *FarWords(P.Metres), *TimeWords(P.Seconds));
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: flight check: short names: \"%s\", \"%s\""), *ShortName(TEXT("Tour Eiffel, 5, Avenue Anatole France, Paris, 75007, France")), *ShortName(TEXT("-36.84100, 174.76830")));
}

// ---------------------------------------------------------------- the flying

void UEarthFlight::Setup(AEarthWalkHUD* InHud)
{
	Hud = InHud;
	Earth = AEarthWorld::Get(InHud);
}

AEarthWalkCharacter* UEarthFlight::Flyer() const
{
	const APlayerController* PC = Hud.IsValid() ? Hud->GetOwningPlayerController() : nullptr;
	return PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
}

bool UEarthFlight::Plan(double Lat, double Lon, FEarthFlightPlan& Out) const
{
	const AEarthWalkCharacter* Me = Flyer();
	if (!Me || !Earth.IsValid() || Me->IsWaitingForGround())
	{
		return false;
	}
	double MyLat = 0.0, MyLon = 0.0, MyAlt = 0.0;
	if (bOn && bGeo)
	{
		MyLat = GeoLat;
		MyLon = GeoLon;
	}
	else
	{
		Earth->WorldToGeo(Me->FeetLocation(), MyLat, MyLon, MyAlt);
	}
	return EarthFlightSums::Plan(MyLat, MyLon, Lat, Lon, Out);
}

bool UEarthFlight::RoofAt(double X, double Z, double& Out) const
{
	const AEarthWalkCharacter* Me = Flyer();
	if (!Earth.IsValid() || !Earth->GetWorld())
	{
		return false;
	}
	FHitResult Hit;
	FCollisionQueryParams Params(FName(TEXT("EarthWalkFlight")), /*bTraceComplex*/ true, Me);
	if (!Earth->GetWorld()->LineTraceSingleByChannel(Hit, FlightToEngine(X, 9000.0, Z), FlightToEngine(X, -3000.0, Z), ECC_Visibility, Params))
	{
		return false;
	}
	Out = Hit.ImpactPoint.Z / 100.0;
	return true;
}

/** What must be cleared at a spot: the ground, or a roof with room over it. False while that part of the world has not arrived. */
bool UEarthFlight::Top(double X, double Z, double& Out) const
{
	double Ground = 0.0, Roof = 0.0;
	if (!Earth.IsValid() || !Earth->TerrainHeightAt(X, Z, Ground))
	{
		return false;
	}
	Out = RoofAt(X, Z, Roof) && Roof > Ground + 0.5 ? Roof + FlightRoofClearM : Ground;
	return true;
}

void UEarthFlight::Note(double Along, double Length)
{
	if (Along < 0.0 || Along > Length || Length < 1.0)
	{
		return;
	}
	const double S = Along / Length;
	double High = 0.0;
	if (!Top(From.X + (EndX - From.X) * S, From.Z + (EndZ - From.Z) * S, High))
	{
		return;
	}
	const int32 Key = FMath::RoundToInt32(Along / FlightNoteM);
	double& Kept = Notes.FindOrAdd(Key, High);
	Kept = FMath::Max(Kept, High);
}

/**
 * Clear ground to land on beside a place in the scene: the place itself when nothing is built there, else
 * the nearest spot round it with no roof over it, on the side the flight comes from, and dry if there is
 * any. False while the ground there has not arrived.
 */
bool UEarthFlight::Landing(double X, double Z, FSpot& Out) const
{
	double Here = 0.0;
	if (!Earth.IsValid() || !Earth->TerrainHeightAt(X, Z, Here))
	{
		return false;
	}
	const auto Clear = [this](double Px, double Pz, FSpot& Spot)
	{
		double Ground = 0.0;
		if (!Earth->TerrainHeightAt(Px, Pz, Ground))
		{
			return false;
		}
		const double Offsets[][2] = { { 0.0, 0.0 }, { 1.2, 0.0 }, { -1.2, 0.0 }, { 0.0, 1.2 }, { 0.0, -1.2 } };
		for (const double* Off : Offsets)
		{
			double Roof = 0.0;
			if (RoofAt(Px + Off[0], Pz + Off[1], Roof) && Roof > Ground + 0.3)
			{
				return false;
			}
		}
		bool bWet = false;
		Spot.X = Px;
		Spot.Z = Pz;
		Spot.Y = Ground;
		Spot.bWet = Earth->WaterAt(Px, Pz, bWet) && bWet;
		return true;
	};
	const double Back = std::atan2(-DirX, DirZ); // the way back to where the flight came from, as an angle round the place
	bool bHaveWet = false;
	FSpot Wet;
	for (const double Ring : FlightRings)
	{
		for (int32 K = 0; K < (Ring > 0.0 ? 12 : 1); ++K)
		{
			// Nearest the way we came first, then round to either side.
			const double Turn = Back + (K % 2 ? 1.0 : -1.0) * FMath::CeilToInt32(K / 2.0) * (UE_DOUBLE_PI / 6.0);
			FSpot Spot;
			if (!Clear(X - std::sin(Turn) * Ring, Z + std::cos(Turn) * Ring, Spot))
			{
				continue;
			}
			if (!Spot.bWet)
			{
				Out = Spot;
				return true;
			}
			if (!bHaveWet)
			{
				bHaveWet = true;
				Wet = Spot;
			}
		}
	}
	if (bHaveWet)
	{
		Out = Wet;
		return true;
	}
	Out.X = X;
	Out.Z = Z;
	Out.Y = Here;
	Out.bWet = false;
	return true;
}

void UEarthFlight::Put(double X, double Y, double Z)
{
	NowX = X;
	NowY = Y;
	NowZ = Z;
	Alt = Y;
	if (AEarthWalkCharacter* Me = Flyer())
	{
		Me->PlaceFeetAt(FlightToEngine(X, Y, Z));
	}
}

bool UEarthFlight::Start(const FString& InName, double Lat, double Lon)
{
	if (bOn)
	{
		TakeOver(true); // on from where the flight that is on has got to
	}
	AEarthWalkCharacter* Me = Flyer();
	FEarthFlightPlan P;
	if (!Me || !Earth.IsValid() || !Plan(Lat, Lon, P))
	{
		return false;
	}
	if (Me->GetMount() || Me->IsCarried())
	{
		if (Hud.IsValid())
		{
			Hud->AddLine(TEXT("Step down first (E), and then you can be flown there."), FlightNotice);
		}
		return false;
	}
	Going = P;
	Name = InName;
	bOn = true;
	Part = P.bLow ? EPart::Low : EPart::Up;
	T = 0.0;
	Generation = Earth->GetGeneration();
	const FVector Feet = Me->FeetLocation();
	From.X = Feet.Y / 100.0;
	From.Z = -Feet.X / 100.0;
	From.Y = Feet.Z / 100.0;
	const double Length = std::hypot(P.Dx, P.Dy);
	DirX = P.Dx / Length;
	DirZ = P.Dy / Length;
	YawDeg = FMath::RadiansToDegrees(std::atan2(P.Dx, -P.Dy));
	TileM0 = TileM1 = Earth->TileMeters();
	EndX = AimX = From.X + P.Dx * TileM0;
	EndZ = AimZ = From.Z + P.Dy * TileM0;
	bLand = false;
	Notes.Reset();
	Base = From.Y;
	Offset = 0.0;
	Alt = From.Y;
	bGeo = false;
	Left = P.Metres;
	bLooked = false;
	bLookSet = false;
	NowX = From.X;
	NowY = From.Y;
	NowZ = From.Z;
	if (P.bLow)
	{
		// What is known of the ground and the roofs along the first of the way, so the climb clears them.
		const double Way = std::hypot(EndX - From.X, EndZ - From.Z);
		for (double Along = 0.0; Along <= FMath::Min(Way, 450.0); Along += FlightNoteM)
		{
			Note(Along, Way);
		}
		double High = 0.0;
		Base = Top(From.X, From.Z, High) ? High : From.Y;
		Offset = From.Y - Base; // from where the player is, not from where the sums start
	}
	Me->SetFlying(false);
	Me->SetFlown(true);
	Me->SetCarried(true);
	Earth->SetFlight(true, false, FVector::ZeroVector, false, 0.0, 0.0);
	Words();
	if (Hud.IsValid())
	{
		Hud->AddLine(FString::Printf(TEXT("Flying to %s: %s, %s. Look round with the mouse; V looks from above; W, A, S, D or Esc takes over.%s"), *EarthFlightSums::ShortName(Name),
			*EarthFlightSums::FarWords(P.Metres), *EarthFlightSums::TimeWords(P.Seconds),
			P.bLow ? TEXT("") : TEXT(" High up in the middle there is only sky and haze: the land between is not drawn.")), FlightNotice);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: flight: to %s, %s, %.0f m, %.1f s, %d steps"), *Name, P.bLow ? TEXT("low") : TEXT("high"), P.Metres, P.Seconds, P.Steps);
	return true;
}

void UEarthFlight::Finish()
{
	bOn = false;
	bGeo = false;
	if (Earth.IsValid())
	{
		Earth->SetFlight(false, false, FVector::ZeroVector, false, 0.0, 0.0);
	}
	if (AEarthWalkCharacter* Me = Flyer())
	{
		Me->SetFlown(false);
		Me->SetCarried(false);
	}
}

void UEarthFlight::TakeOver(bool bQuiet)
{
	if (!bOn)
	{
		return;
	}
	AEarthWalkCharacter* Me = Flyer();
	const bool bHigh = !Going.bLow && (Part == EPart::Over || Part == EPart::Wait || NowY > 1500.0);
	if (bGeo && Earth.IsValid() && Me)
	{
		// Crossing in the haze: the world's middle goes to where the flyer really is, and they are put there at the height they had.
		Earth->SetOrigin(GeoLat, GeoLon);
		Me->PlaceFeetAt(FlightToEngine(0.0, Alt, 0.0));
	}
	Finish();
	if (Me)
	{
		Me->SetFlying(true);
	}
	if (!bQuiet && Hud.IsValid())
	{
		Hud->AddLine(FString::Printf(TEXT("You have taken over, and are flying where you were. W, A, S and D move you, Space and C go up and down, Shift is fast, and F drops you to the ground.%s"),
			bHigh ? TEXT(" You are high in the haze: hold C to come down to where the land is drawn.") : TEXT("")), FlightNotice);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: flight: taken over %.0f m from %s"), Left, *Name);
}

void UEarthFlight::Landed()
{
	AEarthWalkCharacter* Me = Flyer();
	Finish();
	if (Me)
	{
		Me->PlaceFeetAt(FlightToEngine(Land.X, Land.Y + 0.05, Land.Z));
		// Facing the place, if the clear ground is a little way from it.
		APlayerController* PC = Cast<APlayerController>(Me->GetController());
		const double GoalX = Going.bLow ? AimX : 0.0, GoalZ = Going.bLow ? AimZ : 0.0;
		if (PC && !bLooked && std::hypot(GoalX - Land.X, GoalZ - Land.Z) > 1.5)
		{
			FRotator Look = PC->GetControlRotation();
			Look.Yaw = FMath::RadiansToDegrees(std::atan2(GoalX - Land.X, -(GoalZ - Land.Z)));
			Look.Pitch = 0.0;
			PC->SetControlRotation(Look);
		}
	}
	if (Hud.IsValid())
	{
		Hud->AddLine(FString::Printf(TEXT("Here we are: %s."), *EarthFlightSums::ShortName(Name)), FlightNotice);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: flight: landed at %s"), *Name);
}

void UEarthFlight::Words()
{
	const FString To = FString::Printf(TEXT("%s to go"), *EarthFlightSums::FarWords(Left));
	const bool bWaiting = Part == EPart::Wait || (Part == EPart::Settle && !bLand);
	Head = FString::Printf(TEXT("Flying to %s"), *EarthFlightSums::ShortName(Name));
	Sub = bWaiting ? FString(TEXT("the world here is still being built")) : Part == EPart::Over ? To + TEXT("  ·  high over the haze, where no land is drawn") : To;
}

bool UEarthFlight::Frame(float DeltaSeconds, bool bKeysFree)
{
	if (!bOn)
	{
		return false;
	}
	AEarthWalkCharacter* Me = Flyer();
	APlayerController* PC = Me ? Cast<APlayerController>(Me->GetController()) : nullptr;
	// Sent somewhere else meanwhile (Show me, a friend, home), or hopped on something: that wins, quietly.
	if (!Me || !PC || !Earth.IsValid() || Earth->GetGeneration() != Generation || Me->GetMount() || Me->IsWaitingForGround())
	{
		Finish();
		return false;
	}
	if (bKeysFree)
	{
		const bool bEsc = PC->WasInputKeyJustPressed(EKeys::Escape);
		if (bEsc || PC->IsInputKeyDown(EKeys::W) || PC->IsInputKeyDown(EKeys::A) || PC->IsInputKeyDown(EKeys::S) || PC->IsInputKeyDown(EKeys::D)
			|| PC->IsInputKeyDown(EKeys::SpaceBar) || PC->IsInputKeyDown(EKeys::C) || PC->WasInputKeyJustPressed(EKeys::F))
		{
			TakeOver();
			return bEsc;
		}
	}
	const double Dt = DeltaSeconds;
	T += Dt;
	switch (Part)
	{
	case EPart::Low: LowPart(Dt); break;
	case EPart::Up: UpPart(); break;
	case EPart::Over:
	case EPart::Wait: OverPart(Dt); break;
	case EPart::Down: DownPart(); break;
	default: SettlePart(Dt); break;
	}
	if (!bOn)
	{
		return false; // landed
	}
	// How far there is to go.
	double Lat = GeoLat, Lon = GeoLon, AltNow = 0.0;
	if (!bGeo)
	{
		Earth->WorldToGeo(FlightToEngine(NowX, NowY, NowZ), Lat, Lon, AltNow);
	}
	Left = EarthFlightSums::MetresBetween(Lat, Lon, Going.ToLat, Going.ToLon);
	// Where the world is asked for round: a low flight looks a chunk ahead and never past the place; a high one
	// keeps what it took off from while it climbs, and from then on asks only for the place.
	if (Part == EPart::Up)
	{
		Earth->SetFlight(true, true, FlightToEngine(From.X, From.Y, From.Z), false, 0.0, 0.0);
	}
	else if (!Going.bLow)
	{
		Earth->SetFlight(true, true, FVector::ZeroVector, bGeo, GeoLat, GeoLon);
	}
	else if (Part == EPart::Low)
	{
		const double Lead = FMath::Min(Earth->TileMeters(), std::hypot(EndX - NowX, EndZ - NowZ));
		Earth->SetFlight(true, true, FlightToEngine(NowX + DirX * Lead, NowY, NowZ + DirZ * Lead), false, 0.0, 0.0);
	}
	else
	{
		Earth->SetFlight(true, false, FVector::ZeroVector, false, 0.0, 0.0);
	}
	// Until the player looks round for themselves, the view faces the way the flight goes and tips down to the ground.
	const FRotator Looking = PC->GetControlRotation();
	if (bLookSet && (FMath::Abs(FMath::FindDeltaAngleDegrees(Looking.Yaw, LookSet.Yaw)) > 0.05 || FMath::Abs(FMath::FindDeltaAngleDegrees(Looking.Pitch, LookSet.Pitch)) > 0.05))
	{
		bLooked = true;
	}
	if (!bLooked)
	{
		const double Tip = Part == EPart::Low ? -17.0 : Part == EPart::Up ? -29.0 : Part == EPart::Down ? -34.0 : Part == EPart::Settle ? -9.0 : -6.0;
		FRotator Look = Looking;
		Look.Yaw += FMath::Clamp(FMath::FindDeltaAngleDegrees(Look.Yaw, YawDeg), -126.0 * Dt, 126.0 * Dt);
		Look.Pitch += FMath::FindDeltaAngleDegrees(Look.Pitch, Tip) * (1.0 - std::exp(-1.5 * Dt));
		Look.Roll = 0.0;
		PC->SetControlRotation(Look);
		LookSet = PC->GetControlRotation();
		bLookSet = true;
	}
	Words();
	return false;
}

void UEarthFlight::LowPart(double Dt)
{
	// Clear ground beside the place, once the ground there has come: the way bends to it gently.
	if (!bLand)
	{
		bLand = Landing(AimX, AimZ, Land);
		if (bLand)
		{
			AimX = Land.X;
			AimZ = Land.Z;
		}
	}
	const double Bend = 1.0 - std::exp(-2.0 * Dt);
	EndX += (AimX - EndX) * Bend;
	EndZ += (AimZ - EndZ) * Bend;
	const double U = FMath::Clamp(T / Going.Seconds, 0.0, 1.0);
	const double S = FlightSmoother(U);
	const double Lift = FMath::Min(FlightSmooth(U / 0.26), FlightSmooth((1.0 - U) / 0.34));
	const double X = From.X + (EndX - From.X) * S, Z = From.Z + (EndZ - From.Z) * S;
	// The highest thing between here and a few seconds ahead: hills, and roofs with room over them.
	const double Length = std::hypot(EndX - From.X, EndZ - From.Z);
	const double Along = S * Length;
	const double Ahead = FMath::Clamp((std::hypot(X - NowX, Z - NowZ) / FMath::Max(Dt, 1e-3)) * FlightAheadS, 40.0, 450.0);
	for (const double D : { 0.0, Ahead / 2.0, Ahead })
	{
		Note(Along + D, Length);
	}
	double High = -TNumericLimits<double>::Max();
	for (auto It = Notes.CreateIterator(); It; ++It)
	{
		const double At = It.Key() * FlightNoteM;
		if (At < Along - 15.0)
		{
			It.RemoveCurrent();
		}
		else if (At <= Along + Ahead)
		{
			High = FMath::Max(High, It.Value());
		}
	}
	// (Up briskly, down at leisure: between two towers it does not dip.)
	if (High > -TNumericLimits<double>::Max())
	{
		Base += (High - Base) * (1.0 - std::exp(-(High > Base ? 4.0 : 0.9) * Dt));
	}
	// Not down again until the ground at the place is known.
	const double Held = bLand || T < Going.Seconds / 2.0 ? Lift : 1.0;
	double Y = Base + Going.Height * Held + Offset * (1.0 - FlightSmooth(T / 3.0));
	double Here = 0.0;
	if (T > 3.0 && Top(X, Z, Here) && Y < Here + 1.0)
	{
		Y = Here + 1.0;
	}
	Put(X, Y, Z);
	if (T >= Going.Seconds)
	{
		Next(EPart::Settle);
	}
}

bool UEarthFlight::MapGoal(double& X, double& Z, FString& OutName, double& OutLeft) const
{
	if (!bOn)
	{
		return false;
	}
	OutName = EarthFlightSums::ShortName(Name);
	OutLeft = Left;
	if (Going.bLow)
	{
		X = AimX;
		Z = AimZ;
	}
	else if (Part == EPart::Up)
	{
		X = EndX; // the world's origin is still where the flight set off from
		Z = EndZ;
	}
	else
	{
		X = bLand ? Land.X : 0.0; // the origin has moved to the place
		Z = bLand ? Land.Z : 0.0;
	}
	return true;
}

void UEarthFlight::UpPart()
{
	const double U = FMath::Clamp(T / Going.Up, 0.0, 1.0);
	const double Along = Going.Ends * std::pow(U, 2.6);
	const double Lift = std::pow(FlightSmooth(T / Going.Up), 1.7);
	Put(From.X + DirX * Along, From.Y + Going.Height * Lift, From.Z + DirZ * Along);
	if (T < Going.Up)
	{
		return;
	}
	// Lost in the haze: the world's middle moves to the place, and what was round the start goes.
	TileM0 = Earth->TileMeters();
	Earth->SetOrigin(Going.ToLat, Going.ToLon);
	Generation = Earth->GetGeneration();
	TileM1 = Earth->TileMeters();
	Next(EPart::Over);
	OverPart(0.0);
}

void UEarthFlight::OverPart(double Dt)
{
	const bool bWaiting = Part == EPart::Wait;
	// Where the flyer is on the map: from where the climb out left it to where the coming down starts.
	const double X0 = Going.Fx + (DirX * Going.Ends) / TileM0, Y0 = Going.Fy + (DirZ * Going.Ends) / TileM0;
	const double X1 = Going.Fx + Going.Dx - (DirX * Going.Ends) / TileM1, Y1 = Going.Fy + Going.Dy - (DirZ * Going.Ends) / TileM1;
	GeoW = FlightSmooth((bWaiting ? Going.Over : T) / Going.Over);
	const double Mx = X0 + (X1 - X0) * GeoW, My = Y0 + (Y1 - Y0) * GeoW;
	GeoLat = EarthGeo::YToLat(FMath::Clamp(My, 0.0, EarthGeo::TilesAcross - 1e-6));
	GeoLon = EarthGeo::XToLon(FMath::Fmod(FMath::Fmod(Mx, EarthGeo::TilesAcross) + EarthGeo::TilesAcross, EarthGeo::TilesAcross));
	bGeo = true;
	// Level with what the coming down will start from, once the ground at the place is known.
	double Ground = 0.0;
	const bool bGround = Earth->TerrainHeightAt(0.0, 0.0, Ground);
	double Y = Alt;
	if (bGround)
	{
		Y += (Ground + Going.Height - Y) * (1.0 - std::exp(-1.2 * Dt));
	}
	const double Out = Going.Ends + FlightHeldOffM * (1.0 - GeoW);
	Put(-DirX * Out, Y, -DirZ * Out);
	if (!bWaiting && T < Going.Over)
	{
		return;
	}
	if (!bGround)
	{
		if (!bWaiting)
		{
			Next(EPart::Wait); // the world there is still being built: wait above it
		}
		return;
	}
	bGeo = false;
	Came.X = NowX;
	Came.Y = NowY;
	Came.Z = NowZ;
	bLand = Landing(0.0, 0.0, Land);
	if (!bLand)
	{
		Land.X = 0.0;
		Land.Z = 0.0;
		Land.Y = Ground;
		bLand = true;
	}
	Next(EPart::Down);
}

void UEarthFlight::DownPart()
{
	const double U = FMath::Clamp(T / Going.Down, 0.0, 1.0);
	const double LeftAlong = Going.Ends * std::pow(1.0 - U, 2.6);
	const double Lift = std::pow(1.0 - FlightSmooth(T / Going.Down), 1.3);
	const double Q = Going.Ends > 0.0 ? LeftAlong / Going.Ends : 0.0;
	const double X = Land.X + (Came.X - Land.X) * Q, Z = Land.Z + (Came.Z - Land.Z) * Q;
	double Y = Land.Y + (Came.Y - Land.Y) * Lift;
	double Here = 0.0;
	if (Top(X, Z, Here) && Y < Here + 1.0)
	{
		Y = Here + 1.0;
	}
	Put(X, Y, Z);
	if (T >= Going.Down)
	{
		Next(EPart::Settle);
	}
}

/** The last of it: straight down onto the clear ground, slower and slower. Above a place whose ground has not come, it waits. */
void UEarthFlight::SettlePart(double Dt)
{
	if (!bLand)
	{
		bLand = Landing(Going.bLow ? AimX : 0.0, Going.bLow ? AimZ : 0.0, Land);
		if (!bLand)
		{
			return;
		}
	}
	const double K = 1.0 - std::exp(-4.0 * Dt);
	const double X = NowX + (Land.X - NowX) * K, Z = NowZ + (Land.Z - NowZ) * K;
	const double Above = NowY - Land.Y;
	const double Y = FMath::Max(Land.Y, NowY - FMath::Clamp(Above * 2.5, 4.0, 70.0) * Dt);
	Put(X, Y, Z);
	if (Y - Land.Y > 0.02 || std::hypot(Land.X - X, Land.Z - Z) > 0.3)
	{
		return;
	}
	Landed();
}
