#include "EarthInside.h"

#include "EarthAnimalFigure.h"
#include "EarthLifeMotion.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkNet.h"
#include "Components/StaticMeshComponent.h"
#include "Components/TextRenderComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/GameInstance.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "UObject/ConstructorHelpers.h"

#include <cmath>

namespace
{
	constexpr double InsidePaceM = 0.9;   // a stroller's pace, metres a second
	constexpr double InsideWaitS = 4.0;   // and how long they stand at each end of their path
	constexpr uint32 InsideSalt = 0x57414c4b;
	constexpr double InsideNoticeM = 3.5; // someone standing turns to face a player this close
}

AEarthInside::AEarthInside()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	CubeMesh = Cube.Object;
}

const FEarthIndoorPerson* AEarthInside::FindPerson(uint32 PersonId) const
{
	for (const FEarthIndoorPerson& Person : People)
	{
		if (Person.Id == PersonId)
		{
			return &Person;
		}
	}
	return nullptr;
}

void AEarthInside::AddBoard(const FString& Text, const FVector& At, double Yaw, double WidthM, AEarthWorld* World)
{
	// A cream board with lettering, its middle at At, facing Yaw, 2 cm off the wall it hangs on.
	const FRotator Facing(0.0, Yaw, 0.0);
	const double Width = FMath::Clamp(WidthM, 0.4, 8.0) * 100.0;
	const double Height = FMath::Clamp(0.3 * WidthM, 0.2, 0.42) * 100.0;
	UStaticMeshComponent* Board = NewObject<UStaticMeshComponent>(this);
	Board->SetStaticMesh(CubeMesh);
	if (UMaterialInterface* Cream = World ? World->MaterialFor(0xf4f1e6ff) : nullptr)
	{
		Board->SetMaterial(0, Cream);
	}
	Board->SetMobility(EComponentMobility::Movable);
	Board->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Board->SetupAttachment(RootComponent);
	Board->SetWorldLocation(At + Facing.RotateVector(FVector(2.0, 0.0, 0.0)));
	Board->SetWorldRotation(Facing);
	Board->SetWorldScale3D(FVector(3.0, Width, Height) / 100.0);
	Board->RegisterComponent();

	UTextRenderComponent* Label = NewObject<UTextRenderComponent>(this);
	Label->SetMobility(EComponentMobility::Movable);
	Label->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Label->SetupAttachment(RootComponent);
	Label->SetWorldLocation(At + Facing.RotateVector(FVector(4.2, 0.0, 0.0)));
	Label->SetWorldRotation(Facing);
	Label->SetText(FText::FromString(Text));
	Label->SetWorldSize(FMath::Min(static_cast<float>(Height * 0.62), static_cast<float>(Width * 0.92 / (FMath::Max(Text.Len(), 1) * 0.62))));
	Label->SetHorizontalAlignment(EHTA_Center);
	Label->SetVerticalAlignment(EVRTA_TextCenter);
	Label->SetTextRenderColor(FColor(38, 34, 31));
	Label->RegisterComponent();
}

void AEarthInside::Build(const FJsonObject& Json, FIntPoint InChunk, int64 InId, double OriginX, double OriginY, double TileM, AEarthWorld* World)
{
	Chunk = InChunk;
	Building = InId;
	Json.TryGetNumberField(TEXT("size"), Size);
	const auto East = [&](double U) { return (Chunk.X - OriginX + U) * TileM; };
	const auto South = [&](double V) { return (Chunk.Y - OriginY + V) * TileM; };

	const TArray<TSharedPtr<FJsonValue>>* List = nullptr;
	if (Json.TryGetArrayField(TEXT("people"), List))
	{
		for (const TSharedPtr<FJsonValue>& Value : *List)
		{
			const TSharedPtr<FJsonObject>* Item = nullptr;
			double Id = 0.0, U = 0.0, V = 0.0;
			FEarthIndoorPerson Person;
			FString Pose;
			if (!Value.IsValid() || !Value->TryGetObject(Item) || !(*Item)->TryGetNumberField(TEXT("id"), Id) || !(*Item)->TryGetStringField(TEXT("sp"), Person.Sp)
				|| !(*Item)->TryGetNumberField(TEXT("u"), U) || !(*Item)->TryGetNumberField(TEXT("v"), V) || !(*Item)->TryGetNumberField(TEXT("h"), Person.H))
			{
				continue;
			}
			Person.Id = static_cast<uint32>(Id);
			(*Item)->TryGetStringField(TEXT("role"), Person.Role);
			(*Item)->TryGetStringField(TEXT("pose"), Pose);
			(*Item)->TryGetNumberField(TEXT("yaw"), Person.Yaw);
			(*Item)->TryGetNumberField(TEXT("seat"), Person.Seat);
			Person.X = East(U);
			Person.Z = South(V);
			Person.Facing = Person.Yaw;
			Person.Pose = Pose == TEXT("sit") ? 1 : Pose == TEXT("walk") ? 2 : 0;
			const TArray<TSharedPtr<FJsonValue>>* Points = nullptr;
			if (Person.Pose == 2 && (*Item)->TryGetArrayField(TEXT("pts"), Points))
			{
				for (int32 i = 0; i + 1 < Points->Num(); i += 2)
				{
					double Pu = 0.0, Pv = 0.0;
					if ((*Points)[i]->TryGetNumber(Pu) && (*Points)[i + 1]->TryGetNumber(Pv))
					{
						Person.Path.Add(FVector2D(East(Pu), South(Pv)));
					}
				}
				for (int32 i = 1; i < Person.Path.Num(); ++i)
				{
					Person.Length += FVector2D::Distance(Person.Path[i - 1], Person.Path[i]);
				}
			}
			if (Person.Pose == 2 && (Person.Path.Num() < 2 || Person.Length < 0.5))
			{
				Person.Pose = 0; // nowhere to stroll: they stand
			}
			UEarthAnimalFigure* Figure = NewObject<UEarthAnimalFigure>(this);
			Figure->SetupAttachment(RootComponent);
			Figure->RegisterComponent();
			Figure->SetAnimal(Person.Sp);
			Figure->SetWorldScale3D(FVector(AEarthWalkAvatar::FigureScale));
			Figures.Add(Figure);
			Person.Figure = Figure;
			People.Add(Person);
		}
	}
	if (Json.TryGetArrayField(TEXT("signs"), List))
	{
		for (const TSharedPtr<FJsonValue>& Value : *List)
		{
			const TSharedPtr<FJsonObject>* Item = nullptr;
			FString Text;
			double U = 0.0, V = 0.0, H = 0.0, Yaw = 0.0, W = 1.5;
			if (Value.IsValid() && Value->TryGetObject(Item) && (*Item)->TryGetStringField(TEXT("text"), Text) && !Text.IsEmpty()
				&& (*Item)->TryGetNumberField(TEXT("u"), U) && (*Item)->TryGetNumberField(TEXT("v"), V) && (*Item)->TryGetNumberField(TEXT("h"), H))
			{
				(*Item)->TryGetNumberField(TEXT("yaw"), Yaw);
				(*Item)->TryGetNumberField(TEXT("w"), W);
				// Engine axes: +X north, +Y east, +Z up.
				AddBoard(Text, FVector(-South(V) * 100.0, East(U) * 100.0, H * 100.0), Yaw, W, World);
			}
		}
	}
	if (Json.TryGetArrayField(TEXT("tills"), List))
	{
		for (const TSharedPtr<FJsonValue>& Value : *List)
		{
			const TSharedPtr<FJsonObject>* Item = nullptr;
			FEarthShop Till;
			double U = 0.0, V = 0.0;
			if (Value.IsValid() && Value->TryGetObject(Item) && (*Item)->TryGetStringField(TEXT("use"), Till.Use) && (Till.Use == TEXT("shop") || Till.Use == TEXT("food"))
				&& (*Item)->TryGetNumberField(TEXT("u"), U) && (*Item)->TryGetNumberField(TEXT("v"), V))
			{
				(*Item)->TryGetStringField(TEXT("text"), Till.Text);
				Till.Chunk = Chunk;
				Till.X = East(U);
				Till.Z = South(V);
				Tills.Add(Till);
			}
		}
	}
	Tick(0.f); // everybody in their place before the first frame is drawn
}

void AEarthInside::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	const UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	const double T = Net ? Net->Now() : FPlatformTime::Seconds();
	// Where the player is, as east and south, for whoever stands about to look round at them.
	const APlayerController* PC = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr;
	const APawn* Me = PC ? PC->GetPawn() : nullptr;
	const FVector2D Mine = Me ? FVector2D(Me->GetActorLocation().Y / 100.0, -Me->GetActorLocation().X / 100.0) : FVector2D(1e9, 1e9);
	const double MineH = Me ? Me->GetActorLocation().Z / 100.0 : 0.0;
	for (FEarthIndoorPerson& Person : People)
	{
		double Want = Person.Yaw;
		double Up = Person.H;
		Person.bWalking = false;
		if (Person.Pose == 2)
		{
			// There and back for ever, by the room's clock: out, a wait, back, a wait.
			const double Leg = Person.Length / InsidePaceM;
			const double Round = 2.0 * (Leg + InsideWaitS);
			const double Tau = FMath::Fmod(FMath::Fmod(T + EarthLife::Unit(Person.Id, InsideSalt) * Round, Round) + Round, Round);
			double Along = 0.0;
			bool bBack = false;
			if (Tau < Leg) { Along = Tau * InsidePaceM; Person.bWalking = true; }
			else if (Tau < Leg + InsideWaitS) { Along = Person.Length; bBack = true; }
			else if (Tau < 2.0 * Leg + InsideWaitS) { Along = Person.Length - (Tau - Leg - InsideWaitS) * InsidePaceM; bBack = true; Person.bWalking = true; }
			double Left = Along;
			for (int32 i = 1; i < Person.Path.Num(); ++i)
			{
				const double Step = FVector2D::Distance(Person.Path[i - 1], Person.Path[i]);
				if (Left <= Step || i == Person.Path.Num() - 1)
				{
					const double F = Step > 0.0 ? FMath::Clamp(Left / Step, 0.0, 1.0) : 0.0;
					const FVector2D At = FMath::Lerp(Person.Path[i - 1], Person.Path[i], F);
					Person.X = At.X;
					Person.Z = At.Y;
					// The compass heading of this stretch: east and south to north-up degrees.
					const FVector2D Way = (Person.Path[i] - Person.Path[i - 1]) * (bBack ? -1.0 : 1.0);
					Want = FMath::RadiansToDegrees(std::atan2(Way.X, -Way.Y));
					break;
				}
				Left -= Step;
			}
		}
		else if (Person.Pose == 1)
		{
			Up = Person.H + Person.Seat - 0.13; // seated: their feet come to that much under the seat
		}
		else if (FVector2D::Distance(Mine, FVector2D(Person.X, Person.Z)) < InsideNoticeM && FMath::Abs(MineH - Person.H) < 3.0)
		{
			Want = FMath::RadiansToDegrees(std::atan2(Mine.X - Person.X, -(Mine.Y - Person.Z))); // somebody has come up: look at them
		}
		const double Turn = FMath::FindDeltaAngleDegrees(Person.Facing, Want);
		Person.Facing += Turn * FMath::Clamp(DeltaSeconds * (Person.Pose == 2 ? 6.0 : 3.0), 0.0, 1.0);
		if (DeltaSeconds <= 0.f)
		{
			Person.Facing = Want;
		}
		if (Person.Figure)
		{
			// A compass heading is the engine's yaw as it stands, and the figure faces +X.
			Person.Figure->SetWorldLocationAndRotation(FVector(-Person.Z * 100.0, Person.X * 100.0, Up * 100.0), FRotator(0.0, Person.Facing, 0.0));
			FEarthFigureMotion Motion;
			Motion.Speed = Person.bWalking ? static_cast<float>(InsidePaceM * 100.0) : 0.f;
			Motion.bSeated = Person.Pose == 1;
			Person.Figure->Animate(DeltaSeconds, Motion);
		}
	}
}
