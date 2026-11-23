#include "EarthPlay.h"

#include "EarthCompany.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkHUD.h"
#include "EarthWalkNet.h"
#include "EarthWorld.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Actor.h"
#include "GameFramework/PlayerController.h"

#include <cmath>

namespace
{
	constexpr int32 PlayFlags = 28;
	const FLinearColor PlayNotice(0.75f, 0.9f, 1.f);

	const TCHAR* PlayName(const FString& Kind)
	{
		return Kind == TEXT("tag") ? TEXT("tag") : Kind == TEXT("hide") ? TEXT("hide and seek") : TEXT("rounding up");
	}
	FString PlayClock(double Ms)
	{
		const int32 S = FMath::Max(0, FMath::CeilToInt32(Ms / 1000.0));
		return FString::Printf(TEXT("%d:%02d"), S / 60, S % 60);
	}
	FVector PlayToEngine(double X, double Y, double Z) { return FVector(-Z * 100.0, X * 100.0, Y * 100.0); }
}

void UEarthPlay::Setup(AEarthWalkHUD* InHud)
{
	Hud = InHud;
	CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	ConeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cone.Cone"));
	if (UEarthWalkNet* Net = InHud && InHud->GetGameInstance() ? InHud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
	{
		PlayHandle = Net->OnPlay.AddWeakLambda(this, [this]() { Heard(); });
	}
}

void UEarthPlay::Shutdown()
{
	if (UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
	{
		Net->OnPlay.Remove(PlayHandle);
	}
	Clear();
}

void UEarthPlay::Clear()
{
	if (Field)
	{
		Field->Destroy();
		Field = nullptr;
	}
	Arrow = nullptr;
	Flags.Reset();
}

void UEarthPlay::Say(const FString& Text) const
{
	if (Hud.IsValid())
	{
		Hud->AddLine(Text, PlayNotice);
	}
}

bool UEarthPlay::IsOn() const
{
	const UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	return Net && Net->GetGame().bOn;
}

FString UEarthPlay::NameOf(const FString& Id) const
{
	const UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (Net)
	{
		for (const FEarthPlayer& Player : Net->GetGame().Players)
		{
			if (Player.Id == Id)
			{
				return Player.Name;
			}
		}
	}
	return TEXT("Somebody");
}

UStaticMeshComponent* UEarthPlay::AddPart(UStaticMesh* Mesh, uint32 Color)
{
	AEarthWorld* Earth = AEarthWorld::Get(Hud.Get());
	UStaticMeshComponent* Part = NewObject<UStaticMeshComponent>(Field);
	Part->SetStaticMesh(Mesh);
	if (UMaterialInterface* Paint = Earth ? Earth->MaterialFor(Color) : nullptr)
	{
		Part->SetMaterial(0, Paint);
	}
	Part->SetMobility(EComponentMobility::Movable);
	Part->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Part->SetupAttachment(Field->GetRootComponent());
	Part->RegisterComponent();
	Part->SetVisibility(false);
	return Part;
}

/** The game has changed: mark out the field if it is a new one, and say what has happened. */
void UEarthPlay::Heard()
{
	const UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net || !Hud.IsValid())
	{
		return;
	}
	const FEarthGame& Game = Net->GetGame();
	const FString Me = Net->GetMyId();
	const FString Key = Game.bOn ? FString::Printf(TEXT("%s:%.0f"), *Game.By, Game.Made) : FString();
	if (Key != Course)
	{
		Course = Key;
		Clear();
		bBefore = false;
		if (Game.bOn && Hud->GetWorld())
		{
			Field = Hud->GetWorld()->SpawnActor<AActor>(FVector::ZeroVector, FRotator::ZeroRotator);
			if (Field)
			{
				USceneComponent* Root = NewObject<USceneComponent>(Field);
				Field->SetRootComponent(Root);
				Root->RegisterComponent();
				for (int32 i = 0; i < PlayFlags; ++i)
				{
					FFlag Flag;
					if (Game.Kind == TEXT("herd"))
					{
						// A pen: fence posts with a rail to the next, and three left out for a gateway.
						if (i >= 3)
						{
							Flag.Parts.Add(AddPart(CubeMesh, 0x8a5a3aff));
							if (i < PlayFlags - 1)
							{
								Flag.Parts.Add(AddPart(CubeMesh, 0x8a5a3aff));
							}
						}
					}
					else
					{
						Flag.Parts.Add(AddPart(CubeMesh, 0xf4f1eaff)); // the pole
						Flag.Parts.Add(AddPart(CubeMesh, 0xf08a3cff)); // and its orange cloth
					}
					Flags.Add(Flag);
				}
				Arrow = AddPart(ConeMesh, 0xe0352bff);
			}
			Say(Game.Kind == TEXT("herd")
				? (Game.By == Me ? FString(TEXT("Your round-up is set up: the pen is here. Press R to start, alone or once friends have joined.")) : FString::Printf(TEXT("%s has set up a round-up. Press R to join in."), *Game.ByName))
				: Game.By == Me ? FString::Printf(TEXT("Your game of %s is set up, inside the ring of orange flags. Press R to start once a friend has joined."), PlayName(Game.Kind))
				: FString::Printf(TEXT("%s has set up a game of %s. Press R to join in."), *Game.ByName, PlayName(Game.Kind)));
		}
	}
	if (Game.bOn && bBefore)
	{
		if (Game.Kind == TEXT("herd"))
		{
			if (WasState == TEXT("open") && Game.State == TEXT("go"))
			{
				Say(FString::Printf(TEXT("Round them up! Press T beside an animal and it follows you; walk it into the pen. %d are wanted."), Game.Goal));
			}
			if (Game.Penned > WasPenned)
			{
				Say(FString::Printf(TEXT("In the pen: %d of %d."), Game.Penned, Game.Goal));
			}
		}
		else if (WasState == TEXT("open") && Game.State == TEXT("go"))
		{
			Say(Game.Kind == TEXT("tag")
				? (Game.It == Me ? FString(TEXT("You are it! Touch somebody to pass it on.")) : FString::Printf(TEXT("%s is it. Keep away!"), *NameOf(Game.It)))
				: Game.It == Me ? FString(TEXT("You are the seeker. Wait while they hide, then go and find them.")) : FString::Printf(TEXT("%s is the seeker. Hide, inside the ring of flags!"), *NameOf(Game.It)));
		}
		else if (Game.Kind == TEXT("tag") && Game.State == TEXT("go") && WasIt != Game.It)
		{
			Say(Game.It == Me ? FString(TEXT("You are it!")) : FString::Printf(TEXT("%s is it."), *NameOf(Game.It)));
		}
		if (Game.Kind == TEXT("hide"))
		{
			for (const FEarthPlayer& Player : Game.Players)
			{
				if (Player.bFound && !WasFound.Contains(Player.Id))
				{
					Say(Player.Id == Me ? FString(TEXT("You have been found!")) : FString::Printf(TEXT("%s has been found."), *Player.Name));
				}
			}
		}
	}
	bBefore = Game.bOn;
	WasState = Game.State;
	WasIt = Game.It;
	WasPenned = Game.Penned;
	WasFound.Reset();
	for (const FEarthPlayer& Player : Game.Players)
	{
		if (Player.bFound)
		{
			WasFound.Add(Player.Id);
		}
	}
}

void UEarthPlay::Make(const FString& Kind)
{
	UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net || !Net->IsConnected())
	{
		Say(TEXT("Not connected to the meetup server, so no game can be set up yet."));
		return;
	}
	Say(FString::Printf(TEXT("Setting up a game of %s here..."), PlayName(Kind)));
	Net->SendPlay(TEXT("make"), Kind);
}

bool UEarthPlay::Key()
{
	UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net || !Net->GetGame().bOn || Net->GetGame().State == TEXT("over"))
	{
		return false;
	}
	const FEarthGame& Game = Net->GetGame();
	if (Game.State != TEXT("open"))
	{
		return true;
	}
	const FString Me = Net->GetMyId();
	const bool bIn = Game.Players.ContainsByPredicate([&Me](const FEarthPlayer& P) { return P.Id == Me; });
	if (!bIn)
	{
		Net->SendPlay(TEXT("join"));
	}
	else if (Game.By == Me)
	{
		Net->SendPlay(TEXT("go"));
	}
	else
	{
		Say(FString::Printf(TEXT("You are in. %s says when to start."), *Game.ByName));
	}
	return true;
}

bool UEarthPlay::Lead()
{
	UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	const AEarthWorld* Earth = AEarthWorld::Get(Hud.Get());
	if (!Net || !Earth || !Net->GetGame().bOn)
	{
		return false;
	}
	const FEarthGame& Game = Net->GetGame();
	const FString Me = Net->GetMyId();
	if (Game.Kind != TEXT("herd") || Game.State != TEXT("go") || Net->Now() * 1000.0 < Game.StartAt || !Game.Players.ContainsByPredicate([&Me](const FEarthPlayer& P) { return P.Id == Me; }))
	{
		return false;
	}
	UEarthCompany* Friends = Earth->GetCompany();
	if (!Friends || !Friends->LeadNearest())
	{
		Say(TEXT("Stand beside an animal and press T: it will follow you."));
	}
	return true;
}

void UEarthPlay::Stop()
{
	UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (Net && Net->GetGame().bOn)
	{
		Net->SendPlay(TEXT("stop"));
	}
	else
	{
		Say(TEXT("There is no game just now."));
	}
}

void UEarthPlay::Frame(float DeltaSeconds)
{
	const UEarthWalkNet* Net = Hud.IsValid() && Hud->GetGameInstance() ? Hud->GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	AEarthWorld* Earth = AEarthWorld::Get(Hud.Get());
	APlayerController* PC = Hud.IsValid() ? Hud->GetOwningPlayerController() : nullptr;
	AEarthWalkCharacter* Walker = PC ? Cast<AEarthWalkCharacter>(PC->GetPawn()) : nullptr;
	if (!Net || !Earth || !Walker)
	{
		return;
	}
	const FEarthGame& Game = Net->GetGame();
	const FString Mine = Net->GetMyId();
	const double T = Net->Now();
	const double Now = T * 1000.0;
	const FEarthPlayer* Me = Game.bOn ? Game.Players.FindByPredicate([&Mine](const FEarthPlayer& P) { return P.Id == Mine; }) : nullptr;
	const bool bLive = Game.bOn && Game.State == TEXT("go") && Now >= Game.StartAt;

	// Whoever is it runs a little faster than the rest, or nobody would ever be caught.
	const bool bBoost = bLive && Game.Kind == TEXT("tag") && Game.It == Mine;
	if (bBoost != bBoosted)
	{
		bBoosted = bBoost;
		Walker->SetPlayBoost(bBoost ? 1.2f : 1.f);
	}
	if (bLive && Me && Walker->IsFlying())
	{
		Walker->SetFlying(false); // feet on the ground while playing
	}

	// Names hang over everyone so that friends can find each other: not over those the seeker is looking for.
	const bool bHideNames = bLive && Game.Kind == TEXT("hide") && Game.It == Mine;
	if (bHideNames || bNamesHidden)
	{
		for (const FEarthPlayer& Player : Game.Players)
		{
			if (AEarthWalkAvatar* Shown = Player.Id != Mine ? Earth->FindAvatar(Player.Id) : nullptr)
			{
				Shown->SetNameShown(!(bHideNames && !Player.bFound));
			}
		}
		bNamesHidden = bHideNames;
	}

	// The seeker sees nothing while the others hide.
	const bool bCounting = Game.bOn && Game.State == TEXT("go") && Game.Kind == TEXT("hide") && Game.It == Mine && Now >= Game.StartAt && Now < Game.SeekAt;
	if (bCounting || bBlind)
	{
		bBlind = bCounting;
		Hud->SetBlind(bCounting ? FString::Printf(TEXT("No peeking! They are hiding... %d"), FMath::CeilToInt32((Game.SeekAt - Now) / 1000.0)) : FString());
	}

	if (!Game.bOn)
	{
		Panel.Reset();
		Count.Reset();
		return;
	}

	// The ring of flags, each stood on the ground once the ground there has arrived.
	const FVector Middle = Earth->GeoToWorld(Game.Lat, Game.Lon, 0.0);
	const double Cx = Middle.Y / 100.0, Cz = -Middle.X / 100.0;
	const auto Around = [&](int32 i, double& X, double& Z)
	{
		const double A = (static_cast<double>(i) / PlayFlags) * 2.0 * UE_DOUBLE_PI;
		X = Cx + std::sin(A) * Game.Radius;
		Z = Cz + std::cos(A) * Game.Radius;
	};
	for (int32 i = 0; i < Flags.Num(); ++i)
	{
		FFlag& Flag = Flags[i];
		double X = 0.0, Z = 0.0, Y = 0.0;
		Around(i, X, Z);
		if (Flag.bPlaced || Flag.Parts.Num() == 0 || !Earth->TerrainHeightAt(X, Z, Y))
		{
			continue;
		}
		Flag.bPlaced = true;
		if (Game.Kind == TEXT("herd"))
		{
			Flag.Parts[0]->SetWorldLocation(PlayToEngine(X, Y + 0.6, Z));
			Flag.Parts[0]->SetWorldScale3D(FVector(0.14, 0.14, 1.2));
			if (Flag.Parts.Num() > 1)
			{
				// A rail runs on round the ring to the next post.
				double Nx = 0.0, Nz = 0.0;
				Around(i + 1, Nx, Nz);
				const FVector A = PlayToEngine(X, Y + 0.85, Z), B = PlayToEngine(Nx, Y + 0.85, Nz);
				Flag.Parts[1]->SetWorldLocation((A + B) / 2.0);
				Flag.Parts[1]->SetWorldRotation((B - A).Rotation());
				Flag.Parts[1]->SetWorldScale3D(FVector(FVector::Dist(A, B) / 100.0, 0.06, 0.1));
			}
		}
		else
		{
			const FRotator Turn(0.0, FMath::RadiansToDegrees((static_cast<double>(i) / PlayFlags) * 2.0 * UE_DOUBLE_PI), 0.0);
			Flag.Parts[0]->SetWorldLocation(PlayToEngine(X, Y + 1.2, Z));
			Flag.Parts[0]->SetWorldScale3D(FVector(0.08, 0.08, 2.4));
			Flag.Parts[1]->SetWorldLocation(PlayToEngine(X, Y + 2.15, Z) + Turn.RotateVector(FVector(0.0, 39.0, 0.0)));
			Flag.Parts[1]->SetWorldRotation(Turn);
			Flag.Parts[1]->SetWorldScale3D(FVector(0.04, 0.7, 0.42));
		}
		for (UStaticMeshComponent* Part : Flag.Parts)
		{
			Part->SetVisibility(true);
		}
	}

	// An arrow over whoever is it, or seeking, when that is somebody else.
	const AEarthWalkAvatar* ItShown = bLive && !Game.It.IsEmpty() && Game.It != Mine ? Earth->FindAvatar(Game.It) : nullptr;
	if (Arrow)
	{
		Arrow->SetVisibility(ItShown != nullptr);
		if (ItShown)
		{
			Arrow->SetWorldLocation(ItShown->GetActorLocation() + FVector(0.0, 0.0, 270.0 + std::sin(T * 4.0) * 12.0));
			Arrow->SetWorldRotation(FRotator(180.0, 0.0, 0.0)); // point down
			Arrow->SetWorldScale3D(FVector(0.56, 0.56, 0.6));
		}
	}

	// The countdown to the start.
	const bool bGoing = Game.State == TEXT("go");
	const double Until = Game.StartAt - Now;
	Count = !bGoing ? FString() : Until > 0.0 ? FString::FromInt(FMath::CeilToInt32(Until / 1000.0)) : Until > -1200.0 ? FString(TEXT("GO!")) : FString();

	// The panel.
	TArray<FString> Lines;
	const FVector Feet = Walker->FeetLocation();
	const bool bOut = Me && bLive && Game.Kind != TEXT("herd") && std::hypot(Feet.Y / 100.0 - Cx, -Feet.X / 100.0 - Cz) > Game.Radius;
	TArray<FString> Names;
	for (const FEarthPlayer& Player : Game.Players)
	{
		Names.Add(Player.Name);
	}
	if (Game.State == TEXT("open"))
	{
		Lines.Add(FString::Printf(TEXT("%s, set up by %s"), Game.Kind == TEXT("tag") ? TEXT("Tag") : Game.Kind == TEXT("hide") ? TEXT("Hide and seek") : TEXT("A round-up"), *Game.ByName));
		Lines.Add(FString::Printf(TEXT("In: %s"), *FString::Join(Names, TEXT(", "))));
		Lines.Add(!Me ? FString(TEXT("R: join in")) : Game.By == Mine ? (Game.Kind != TEXT("herd") && Game.Players.Num() < 2 ? FString(TEXT("Waiting for a friend to join")) : FString(TEXT("R: start the game")))
			: FString::Printf(TEXT("Waiting for %s to start"), *Game.ByName));
	}
	else if (bGoing && !bLive)
	{
		Lines.Add(TEXT("Get ready..."));
	}
	else if (Game.Kind == TEXT("herd"))
	{
		if (bGoing)
		{
			Lines.Add(FString::Printf(TEXT("In the pen: %d of %d"), Game.Penned, Game.Goal));
			Lines.Add(FString::Printf(TEXT("%s left"), *PlayClock(Game.EndAt - Now)));
			Lines.Add(TEXT("T beside an animal: it follows you"));
			Lines.Add(TEXT("Walk it into the pen"));
		}
		else
		{
			Lines.Add(Game.Penned >= Game.Goal ? TEXT("The herd is home!") : TEXT("The round-up is over"));
			Lines.Add(FString::Printf(TEXT("%d of %d brought in"), Game.Penned, Game.Goal));
		}
		if (Game.Players.Num() > 1)
		{
			for (const FEarthPlayer& Player : Game.Players)
			{
				Lines.Add(FString::Printf(TEXT("%s: %.0f"), *Player.Name, Player.ItMs));
			}
		}
	}
	else if (Game.Kind == TEXT("tag"))
	{
		if (bGoing)
		{
			Lines.Add(Game.It == Mine ? FString(TEXT("You are IT: touch somebody!")) : FString::Printf(TEXT("%s is it: keep away!"), *NameOf(Game.It)));
			Lines.Add(FString::Printf(TEXT("%s left"), *PlayClock(Game.EndAt - Now)));
		}
		else
		{
			Lines.Add(TEXT("Tag is over"));
		}
		TArray<FEarthPlayer> Sorted = Game.Players;
		Sorted.Sort([](const FEarthPlayer& A, const FEarthPlayer& B) { return A.ItMs < B.ItMs; });
		for (const FEarthPlayer& Player : Sorted)
		{
			const double Ms = Player.ItMs + (bGoing && Player.Id == Game.It ? FMath::Max(0.0, Now - Game.Since) : 0.0);
			Lines.Add(FString::Printf(TEXT("%s: it for %d s"), *Player.Name, FMath::RoundToInt32(Ms / 1000.0)));
		}
	}
	else
	{
		TArray<FString> Hidden;
		int32 Hiders = 0;
		for (const FEarthPlayer& Player : Game.Players)
		{
			if (Player.Id != Game.It)
			{
				++Hiders;
				if (!Player.bFound)
				{
					Hidden.Add(Player.Name);
				}
			}
		}
		const bool bSeeking = bLive && Now >= Game.SeekAt;
		if (Game.State == TEXT("over"))
		{
			Lines.Add(TEXT("Hide and seek is over"));
			Lines.Add(Hidden.Num() ? FString::Printf(TEXT("Never found: %s"), *FString::Join(Hidden, TEXT(", "))) : FString::Printf(TEXT("%s found everyone"), *NameOf(Game.It)));
		}
		else if (!bSeeking)
		{
			Lines.Add(Game.It == Mine ? FString(TEXT("Wait while they hide")) : FString::Printf(TEXT("Hide! %s comes looking in %d s"), *NameOf(Game.It), FMath::CeilToInt32((Game.SeekAt - Now) / 1000.0)));
		}
		else
		{
			Lines.Add(Game.It == Mine ? FString::Printf(TEXT("Find them: %d still hidden"), Hidden.Num()) : Me && Me->bFound ? FString(TEXT("You were found. Watch the rest!")) : FString(TEXT("Stay hidden!")));
			Lines.Add(FString::Printf(TEXT("%s left"), *PlayClock(Game.EndAt - Now)));
			for (const FEarthPlayer& Player : Game.Players)
			{
				if (Player.Id != Game.It)
				{
					Lines.Add(FString::Printf(TEXT("%s: %s"), *Player.Name, Player.bFound ? TEXT("found") : TEXT("hiding")));
				}
			}
		}
	}
	if (bOut && bGoing)
	{
		Lines.Insert(TEXT("Back inside the flags!"), 0);
	}
	if (Game.State == TEXT("over"))
	{
		Lines.Add(TEXT("/tag, /hide or /herd for another"));
	}
	Panel = FString::Join(Lines, TEXT("\n"));
}
