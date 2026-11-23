#include "EarthShowcase.h"

#include "EarthCompany.h"
#include "EarthLife.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Dom/JsonObject.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
	/** A thing this near is used where it is; further off, the show's own place is travelled to. */
	constexpr double ShowNearM = 500.0;
	/** After arriving at a show's place, how far from it to look, and how long to wait for the world to fill in. */
	constexpr double AtPlaceM = 900.0;
	constexpr double WaitSeconds = 25.0;
	/** Nobody showing the world to a friend wants to stand by an empty track: a train further off than this many seconds is gone to instead. */
	constexpr double TrainSoonS = 30.0;

	FVector ShowSceneToEngine(double X, double Y, double Z) { return FVector(-Z * 100.0, X * 100.0, Y * 100.0); }
	double Radians(double Degrees) { return (Degrees * UE_DOUBLE_PI) / 180.0; }
}

void UEarthShowcase::Setup(AEarthWorld* InWorld)
{
	World = InWorld;
}

void UEarthShowcase::Load(TFunction<void(bool bOk)> Done)
{
	if (bLoaded)
	{
		Done(true);
		return;
	}
	Waiting.Add(MoveTemp(Done));
	if (bLoading)
	{
		return;
	}
	bLoading = true;
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("%s/v1/showcase"), *FEarthWalkConfig::ServerUrl()));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(30.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		bLoading = false;
		TSharedPtr<FJsonObject> Json;
		const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200
			&& FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Response->GetContentAsString()), Json) && Json.IsValid()
			&& Json->TryGetArrayField(TEXT("shows"), List))
		{
			Shows.Reset();
			for (const TSharedPtr<FJsonValue>& Value : *List)
			{
				const TSharedPtr<FJsonObject>* Row = nullptr;
				const TSharedPtr<FJsonObject>* Place = nullptr;
				FEarthShow Show;
				if (!Value.IsValid() || !Value->TryGetObject(Row) || !(*Row)->TryGetStringField(TEXT("id"), Show.Id) || !(*Row)->TryGetObjectField(TEXT("place"), Place)
					|| !(*Place)->TryGetNumberField(TEXT("lat"), Show.Lat) || !(*Place)->TryGetNumberField(TEXT("lon"), Show.Lon))
				{
					continue;
				}
				(*Row)->TryGetStringField(TEXT("title"), Show.Title);
				(*Row)->TryGetStringField(TEXT("text"), Show.Text);
				(*Row)->TryGetStringField(TEXT("how"), Show.How);
				(*Row)->TryGetStringField(TEXT("find"), Show.Find);
				(*Row)->TryGetBoolField(TEXT("ride"), Show.bRide);
				Show.bYaw = (*Row)->TryGetNumberField(TEXT("yaw"), Show.Yaw);
				(*Place)->TryGetStringField(TEXT("name"), Show.Place);
				const TArray<TSharedPtr<FJsonValue>>* Kinds = nullptr;
				if ((*Row)->TryGetArrayField(TEXT("sp"), Kinds))
				{
					for (const TSharedPtr<FJsonValue>& Kind : *Kinds)
					{
						if (Kind.IsValid() && !Kind->AsString().IsEmpty())
						{
							Show.Sp.Add(Kind->AsString());
						}
					}
				}
				// A show whose way of finding its thing this game does not know is left out.
				if (Show.Find == TEXT("train") || Show.Find == TEXT("home") || Show.Find == TEXT("car") || Show.Find == TEXT("door") || Show.Find == TEXT("air"))
				{
					Shows.Add(MoveTemp(Show));
				}
			}
			bLoaded = true;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: showcase: %d things to show"), Shows.Num());
		}
		else
		{
			UE_LOG(LogTemp, Warning, TEXT("EarthWalk: showcase: the list did not come (%d)"), Response.IsValid() ? Response->GetResponseCode() : 0);
		}
		TArray<TFunction<void(bool)>> Told = MoveTemp(Waiting);
		Waiting.Reset();
		for (const TFunction<void(bool)>& Tell : Told)
		{
			Tell(bLoaded);
		}
	});
	Request->ProcessRequest();
}

void UEarthShowcase::Go(const FString& What)
{
	const TWeakObjectPtr<UEarthShowcase> Weak(this);
	Load([Weak, What](bool bOk)
	{
		UEarthShowcase* Self = Weak.Get();
		if (!Self)
		{
			return;
		}
		if (!bOk)
		{
			Self->Problem(TEXT("The world server is not answering just now. Try again in a moment."));
			return;
		}
		Self->Start(What);
	});
}

void UEarthShowcase::Start(const FString& What)
{
	const FString Asked = What.TrimStartAndEnd().ToLower();
	const FEarthShow* Show = Shows.FindByPredicate([&Asked](const FEarthShow& S) { return S.Id == Asked; });
	if (!Show && !Asked.IsEmpty())
	{
		Show = Shows.FindByPredicate([&Asked](const FEarthShow& S) { return S.Title.ToLower().Contains(Asked); });
	}
	if (!Show)
	{
		Problem(FString::Printf(TEXT("There is nothing called \"%s\" to show. Press G for the list."), *What));
		return;
	}
	AEarthWorld* Earth = World.Get();
	AEarthWalkCharacter* Me = Player.Get();
	if (!Earth || !Me)
	{
		return;
	}
	if (Me->IsWaitingForGround())
	{
		Problem(TEXT("Wait until you have landed, then try again."));
		return;
	}
	if (UEarthCompany* Company = Earth->GetCompany())
	{
		Company->HopOff();
	}
	if (Me->IsFlying())
	{
		Me->SetFlying(false);
	}
	bSnap = false;
	const FVector Feet = Me->FeetLocation();
	FEarthSpot Spot;
	if (Show->Find != TEXT("air") && Look(*Show, Feet.Y / 100.0, -Feet.X / 100.0, ShowNearM, Spot) && !(Show->Find == TEXT("train") && Spot.In > TrainSoonS))
	{
		bPending = false;
		Stand(*Show, Spot);
		return;
	}
	Say(FString::Printf(TEXT("%s: going to %s..."), *Show->Title, *Show->Place));
	Pending = *Show; // before the journey: the list may be asked for again while we are away
	bPending = true;
	PendingSince = 0.0;
	bHopped = false;
	Me->TeleportToGeo(Pending.Lat, Pending.Lon);
}

bool UEarthShowcase::Look(const FEarthShow& Show, double FromX, double FromZ, double Within, FEarthSpot& Out) const
{
	const AEarthWorld* Earth = World.Get();
	const AEarthLife* Life = Earth ? Earth->GetLife() : nullptr;
	if (!Life)
	{
		return false;
	}
	if (Show.Find == TEXT("train"))
	{
		// The trains are counted from the chunks this game holds now, so the last place's are never in the list.
		// A train standing still is easiest to board, so one of those is worth waiting a little longer for.
		TArray<FEarthSpot> Stops;
		Life->Boarding(Now, FromX, FromZ, Within, Stops);
		bool bFound = false;
		double Best = 0.0;
		for (const FEarthSpot& Stop : Stops)
		{
			const double Score = Stop.In + (Stop.bPassing ? 25.0 : 0.0);
			if (!bFound || Score < Best)
			{
				bFound = true;
				Best = Score;
				Out = Stop;
			}
		}
		return bFound;
	}
	if (Show.Find == TEXT("home"))
	{
		return Life->NearestHome(Show.Sp, FromX, FromZ, Within, Out);
	}
	if (Show.Find == TEXT("car"))
	{
		return Life->NearestParked(FromX, FromZ, Within, Out);
	}
	if (Show.Find == TEXT("door"))
	{
		TArray<FEarthDoor> Doors;
		Earth->DoorsNear(FromX, FromZ, Within, Doors);
		bool bFound = false;
		double Best = Within;
		for (const FEarthDoor& Door : Doors)
		{
			if (!Door.Use.IsEmpty())
			{
				continue; // a shop or an office: the show is of a house
			}
			const double D = FMath::Sqrt(FMath::Square(Door.X - FromX) + FMath::Square(Door.Z - FromZ));
			if (D <= Best)
			{
				bFound = true;
				Best = D;
				Out = FEarthSpot();
				Out.X = Door.X;
				Out.Z = Door.Z;
				Out.Yaw = Door.Yaw;
			}
		}
		return bFound;
	}
	return false;
}

bool UEarthShowcase::Put(double X, double Z, double LookX, double LookZ)
{
	const AEarthWorld* Earth = World.Get();
	AEarthWalkCharacter* Me = Player.Get();
	double Ground = 0.0;
	if (!Earth || !Me || !Earth->TerrainHeightAt(X, Z, Ground))
	{
		return false;
	}
	Me->PlaceFeetAt(ShowSceneToEngine(X, Ground + 0.3, Z));
	if (APlayerController* PC = Cast<APlayerController>(Me->GetController()))
	{
		// The compass heading from here to there: east over north.
		PC->SetControlRotation(FRotator(0.0, FMath::RadiansToDegrees(FMath::Atan2(LookX - X, -(LookZ - Z))), 0.0));
	}
	return true;
}

void UEarthShowcase::Stand(const FEarthShow& Show, const FEarthSpot& Spot)
{
	AEarthWalkCharacter* Me = Player.Get();
	if (!Me)
	{
		return;
	}
	const FVector Feet = Me->FeetLocation();
	const double Px = Feet.Y / 100.0, Pz = -Feet.X / 100.0;
	double X = Spot.X, Z = Spot.Z;
	FString Extra;
	if (Show.Find == TEXT("train"))
	{
		// Beside the track, on the side the player is already on.
		const double H = Radians(Spot.Heading);
		const double Side = (Px - Spot.X) * FMath::Cos(H) + (Pz - Spot.Z) * FMath::Sin(H) < 0.0 ? -1.0 : 1.0;
		// A standing train can be looked at from a few steps back; a passing one must be within reach as it goes by.
		const double Back = Spot.bPassing ? 5.5 : 7.0;
		X += FMath::Cos(H) * Back * Side;
		Z += FMath::Sin(H) * Back * Side;
		const FString Soon = Spot.In < 50.0 ? FString::Printf(TEXT("about %d seconds"), FMath::Max(5, FMath::RoundToInt32(Spot.In / 5.0) * 5))
			: Spot.In < 100.0 ? FString(TEXT("about a minute")) : FString::Printf(TEXT("about %d minutes"), FMath::RoundToInt32(Spot.In / 60.0));
		Extra = Spot.bPassing ? FString::Printf(TEXT(" A train comes past here in %s without stopping: press E as it goes by to jump on."), *Soon)
			: Spot.In < 3.0 ? FString(TEXT(" The train is standing right here.")) : FString::Printf(TEXT(" The train draws in here in %s."), *Soon);
	}
	else if (Show.Find == TEXT("home"))
	{
		// Just outside the ground the animals roam on, on the side the player came from (the south, failing that).
		double Dx = Px - Spot.X, Dz = Pz - Spot.Z;
		const double D = FMath::Sqrt(Dx * Dx + Dz * Dz);
		if (D < 1.0 || D > ShowNearM)
		{
			Dx = 0.0;
			Dz = 1.0;
		}
		else
		{
			Dx /= D;
			Dz /= D;
		}
		const double Out = Show.bRide ? FMath::Min(Spot.R, 6.0) : Spot.R + 3.0;
		X += Dx * Out;
		Z += Dz * Out;
		if (Show.bRide)
		{
			bSnap = true;
			SnapSp = Show.Sp;
			SnapAt = FPlatformTime::Seconds() + 0.7;
			SnapUntil = FPlatformTime::Seconds() + 6.0;
		}
	}
	else if (Show.Find == TEXT("car"))
	{
		const double H = Radians(Spot.Yaw); // beside the driver's door, more or less
		X += FMath::Cos(H) * 3.1;
		Z += FMath::Sin(H) * 3.1;
	}
	else if (Show.Find == TEXT("door"))
	{
		const double H = Radians(Spot.Yaw); // the way out of the door: stand on the path, within reach of the handle
		X += FMath::Sin(H) * 1.9;
		Z -= FMath::Cos(H) * 1.9;
	}
	if (!Put(X, Z, Spot.X, Spot.Z))
	{
		Put(Spot.X, Spot.Z, Spot.X, Spot.Z - 1.0);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: showcase: \"%s\": stood at %.1f east, %.1f south of the origin (the thing is at %.1f, %.1f; in %.0f s, passing %d)"),
		*Show.Id, X, Z, Spot.X, Spot.Z, Spot.In, Spot.bPassing ? 1 : 0);
	Say(FString::Printf(TEXT("%s. %s%s"), *Show.Title, *Show.How, *Extra));
}

void UEarthShowcase::Frame(AEarthWalkCharacter* InPlayer, double T)
{
	Player = InPlayer;
	Now = T;
	AEarthWorld* Earth = World.Get();
	AEarthWalkCharacter* Me = Player.Get();
	if (!Earth || !Me)
	{
		return;
	}
	const double Clock = FPlatformTime::Seconds();
	if (bPending && !Me->IsWaitingForGround())
	{
		if (PendingSince == 0.0)
		{
			PendingSince = Clock; // landed
		}
		if (Pending.Find == TEXT("air"))
		{
			bPending = false;
			Me->SetFlying(true);
			Me->PlaceFeetAt(Me->FeetLocation() + FVector(0.0, 0.0, 17000.0));
			if (APlayerController* PC = Cast<APlayerController>(Me->GetController()))
			{
				FRotator Look = PC->GetControlRotation();
				Look.Pitch = -26.0; // looking down a little
				if (Pending.bYaw)
				{
					Look.Yaw = Pending.Yaw; // facing what is shown: a compass heading is the engine's yaw
				}
				PC->SetControlRotation(Look);
			}
			Say(FString::Printf(TEXT("%s. %s"), *Pending.Title, *Pending.How));
		}
		else
		{
			// The animals, cars, doors and trains come a moment after the ground does.
			const bool bFilled = Earth->HasLabelsAt(Me->GetActorLocation());
			FEarthSpot Spot;
			const bool bSpot = bFilled && Look(Pending, 0.0, 0.0, bHopped ? 400.0 : AtPlaceM, Spot);
			// No train due here for a while: go along the line to where one is, once, and catch it there.
			bool bFar = false;
			FEarthSpot Far;
			if (bFilled && Pending.Find == TEXT("train") && !bHopped && !(bSpot && Spot.In <= TrainSoonS) && Earth->GetLife())
			{
				TArray<FEarthSpot> Soonest;
				Earth->GetLife()->Soonest(Now, Soonest);
				double Best = 0.0;
				for (const FEarthSpot& Stop : Soonest)
				{
					const double Score = Stop.In + (Stop.bPassing ? 10.0 : 0.0);
					if (!bFar || Score < Best)
					{
						bFar = true;
						Best = Score;
						Far = Stop;
					}
				}
			}
			if (bFar)
			{
				double Lat = 0.0, Lon = 0.0, Alt = 0.0;
				Earth->WorldToGeo(ShowSceneToEngine(Far.X, 0.0, Far.Z), Lat, Lon, Alt);
				UE_LOG(LogTemp, Display, TEXT("EarthWalk: showcase: no train due here; going along the line to one %.0f s off (passing %d)"), Far.In, Far.bPassing ? 1 : 0);
				bHopped = true;
				PendingSince = 0.0;
				Me->TeleportToGeo(Lat, Lon);
			}
			else if (bSpot && (Pending.Find != TEXT("train") || Spot.In <= TrainSoonS || bHopped || Clock - PendingSince > 3.0))
			{
				bPending = false;
				Stand(Pending, Spot);
			}
			else if (Clock - PendingSince > WaitSeconds)
			{
				bPending = false;
				Say(FString::Printf(TEXT("You are at %s. %s Have a look round. %s"), *Pending.Place, *Pending.Text, *Pending.How));
			}
		}
	}
	// Something to ride: once the animals here are being drawn, stand within reach of the nearest.
	if (bSnap && Clock > SnapAt && Earth->GetLife())
	{
		const FVector Feet = Me->FeetLocation();
		const double Px = Feet.Y / 100.0, Pz = -Feet.X / 100.0;
		const FEarthThing* Best = nullptr;
		double BestD = 0.0;
		for (const FEarthThing& Thing : Earth->GetLife()->GetRideable())
		{
			if (!SnapSp.Contains(Thing.Sp) || Thing.bOutOfPlace)
			{
				continue;
			}
			const double D = FMath::Sqrt(FMath::Square(Thing.X - Px) + FMath::Square(Thing.Z - Pz));
			if (!Best || D < BestD)
			{
				Best = &Thing;
				BestD = D;
			}
		}
		if (Best)
		{
			bSnap = false;
			if (BestD > 2.5)
			{
				const double Dx = (Px - Best->X) / BestD, Dz = (Pz - Best->Z) / BestD;
				const double Gap = Best->Sp == TEXT("tractor") || Best->Sp == TEXT("boat") || Best->Sp == TEXT("sailboat") ? 2.7 : 2.2; // a little room for the big ones
				Put(Best->X + Dx * Gap, Best->Z + Dz * Gap, Best->X, Best->Z);
				UE_LOG(LogTemp, Display, TEXT("EarthWalk: showcase: stood %.1f m from the nearest %s"), Gap, *Best->Sp);
			}
		}
		else if (Clock > SnapUntil)
		{
			bSnap = false;
		}
	}
}
