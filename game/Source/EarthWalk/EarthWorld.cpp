#include "EarthWorld.h"

#include "EarthGeo.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "Components/CapsuleComponent.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Character.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "ProceduralMeshComponent.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr uint32 ChunkMagic = 0x31435745; // "EWC1"
	constexpr uint32 ChunkVersion = 1;
	constexpr uint32 FlagCollision = 1;
	constexpr int32 MaxRequestsInFlight = 4;
}

AEarthWorld::AEarthWorld()
{
	PrimaryActorTick.bCanEverTick = true;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));

	// A plain lit engine material with a "Color" parameter; every surface gets a tinted instance of it.
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Material(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	BaseMaterial = Material.Object;
}

AEarthWorld* AEarthWorld::Get(const UObject* WorldContext)
{
	if (UWorld* World = WorldContext ? WorldContext->GetWorld() : nullptr)
	{
		for (TActorIterator<AEarthWorld> It(World); It; ++It)
		{
			return *It;
		}
	}
	return nullptr;
}

void AEarthWorld::BeginPlay()
{
	Super::BeginPlay();
	double Lat = 0.0, Lon = 0.0;
	FEarthWalkConfig::StartLocation(Lat, Lon);
	SetOrigin(Lat, Lon);
}

void AEarthWorld::EndPlay(const EEndPlayReason::Type EndPlayReason)
{
	// Remember where the player was, so the next session starts there.
	if (const APlayerController* Controller = GetWorld()->GetFirstPlayerController())
	{
		if (const APawn* Pawn = Controller->GetPawn())
		{
			double Lat, Lon, Alt;
			WorldToGeo(Pawn->GetActorLocation(), Lat, Lon, Alt);
			FEarthWalkConfig::Save(TEXT("Lat"), FString::Printf(TEXT("%.6f"), Lat));
			FEarthWalkConfig::Save(TEXT("Lon"), FString::Printf(TEXT("%.6f"), Lon));
		}
	}
	Super::EndPlay(EndPlayReason);
}

void AEarthWorld::SetOrigin(double Lat, double Lon)
{
	Lat = FMath::Clamp(Lat, -85.0, 85.0);
	OriginLat = Lat;
	OriginX = EarthGeo::LonToX(Lon);
	OriginY = EarthGeo::LatToY(Lat);
	TileCm = EarthGeo::MetersPerTile(Lat) * 100.0;
	++Generation;

	for (const TPair<FIntPoint, TObjectPtr<UProceduralMeshComponent>>& Pair : Chunks)
	{
		if (Pair.Value)
		{
			Pair.Value->DestroyComponent();
		}
	}
	Chunks.Reset();
	Pending.Reset();
	RetryAfter.Reset();
	ChunkTimer = 0.f;
}

FVector AEarthWorld::GeoToWorld(double Lat, double Lon, double AltMeters) const
{
	return FVector(
		-(EarthGeo::LatToY(Lat) - OriginY) * TileCm,
		(EarthGeo::LonToX(Lon) - OriginX) * TileCm,
		AltMeters * 100.0);
}

void AEarthWorld::WorldToGeo(const FVector& Position, double& OutLat, double& OutLon, double& OutAltMeters) const
{
	OutLat = EarthGeo::YToLat(OriginY - Position.X / TileCm);
	OutLon = EarthGeo::XToLon(OriginX + Position.Y / TileCm);
	OutAltMeters = Position.Z / 100.0;
}

FIntPoint AEarthWorld::ChunkAt(const FVector& Position) const
{
	return FIntPoint(
		FMath::FloorToInt32(OriginX + Position.Y / TileCm),
		FMath::FloorToInt32(OriginY - Position.X / TileCm));
}

bool AEarthWorld::HasChunkAt(const FVector& Position) const
{
	return Chunks.Contains(ChunkAt(Position));
}

void AEarthWorld::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);

	const APlayerController* Controller = GetWorld()->GetFirstPlayerController();
	const ACharacter* Player = Controller ? Cast<ACharacter>(Controller->GetPawn()) : nullptr;
	if (!Player)
	{
		return;
	}

	ChunkTimer -= DeltaSeconds;
	if (ChunkTimer <= 0.f)
	{
		ChunkTimer = 0.25f;
		UpdateChunks(Player->GetActorLocation());
	}

	// Tell the room where we are, ten times a second.
	SendTimer -= DeltaSeconds;
	if (SendTimer <= 0.f)
	{
		SendTimer = 0.1f;
		if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
		{
			const FVector Feet = Player->GetActorLocation() - FVector(0, 0, Player->GetCapsuleComponent()->GetScaledCapsuleHalfHeight());
			double Lat, Lon, Alt;
			WorldToGeo(Feet, Lat, Lon, Alt);
			Net->SendPosition(Lat, Lon, Alt, Controller->GetControlRotation().Yaw);
		}
	}

	UpdateAvatars();
}

void AEarthWorld::UpdateChunks(const FVector& Around)
{
	const int32 Radius = FMath::Clamp(GetDefault<UEarthWalkSettings>()->ViewRadiusChunks, 1, 6);
	const FIntPoint Center = ChunkAt(Around);

	// Drop chunks that are well out of view.
	for (auto It = Chunks.CreateIterator(); It; ++It)
	{
		const FIntPoint Delta = It.Key() - Center;
		if (FMath::Max(FMath::Abs(Delta.X), FMath::Abs(Delta.Y)) > Radius + 1)
		{
			if (It.Value())
			{
				It.Value()->DestroyComponent();
			}
			It.RemoveCurrent();
		}
	}

	// Request missing chunks, nearest first.
	TArray<FIntPoint> Wanted;
	const double Now = FPlatformTime::Seconds();
	for (int32 DY = -Radius; DY <= Radius; ++DY)
	{
		for (int32 DX = -Radius; DX <= Radius; ++DX)
		{
			const FIntPoint Key(Center.X + DX, Center.Y + DY);
			if (Key.Y < 0 || Key.Y >= 65536 || Chunks.Contains(Key) || Pending.Contains(Key))
			{
				continue;
			}
			if (const double* Until = RetryAfter.Find(Key))
			{
				if (Now < *Until)
				{
					continue;
				}
			}
			Wanted.Add(Key);
		}
	}
	Wanted.Sort([Center](const FIntPoint& A, const FIntPoint& B)
	{
		return (A - Center).SizeSquared() < (B - Center).SizeSquared();
	});
	for (const FIntPoint& Key : Wanted)
	{
		if (Pending.Num() >= MaxRequestsInFlight)
		{
			break;
		}
		RequestChunk(Key);
	}
}

void AEarthWorld::RequestChunk(FIntPoint Key)
{
	Pending.Add(Key);
	const int32 WrappedX = ((Key.X % 65536) + 65536) % 65536;
	const FString Url = FString::Printf(TEXT("%s/v1/chunk/%d/%d/%d"), *FEarthWalkConfig::ServerUrl(), EarthGeo::ChunkZoom, WrappedX, Key.Y);

	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(Url);
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(90.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	const int32 RequestGeneration = Generation;
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Key, RequestGeneration](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		if (RequestGeneration != Generation)
		{
			return; // the player teleported away while this was loading
		}
		Pending.Remove(Key);
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200 && BuildChunk(Key, Response->GetContent()))
		{
			LastError.Reset();
			RetryAfter.Remove(Key);
			return;
		}
		if (!bConnected || !Response.IsValid())
		{
			LastError = FString::Printf(TEXT("Cannot reach the world server at %s"), *FEarthWalkConfig::ServerUrl());
		}
		else if (Response->GetResponseCode() == 401)
		{
			LastError = TEXT("The world server needs an access code. Type /code <code>");
		}
		else
		{
			LastError = FString::Printf(TEXT("The world server could not build part of this area (HTTP %d)"), Response->GetResponseCode());
		}
		RetryAfter.Add(Key, FPlatformTime::Seconds() + 10.0);
	});
	Request->ProcessRequest();
}

UMaterialInstanceDynamic* AEarthWorld::MaterialFor(uint32 Rgba)
{
	if (const TObjectPtr<UMaterialInstanceDynamic>* Found = Materials.Find(Rgba))
	{
		return *Found;
	}
	UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
	if (Material)
	{
		const FColor Color((Rgba >> 24) & 0xff, (Rgba >> 16) & 0xff, (Rgba >> 8) & 0xff, 255);
		Material->SetVectorParameterValue(TEXT("Color"), FLinearColor::FromSRGBColor(Color));
	}
	Materials.Add(Rgba, Material);
	return Material;
}

/** Decodes an EWC1 chunk (docs/PROTOCOL.md) into one procedural mesh component. */
bool AEarthWorld::BuildChunk(FIntPoint Key, const TArray<uint8>& Data)
{
	const uint8* Bytes = Data.GetData();
	const int64 Size = Data.Num();
	const auto U32 = [Bytes](int64 Offset)
	{
		uint32 Value;
		FMemory::Memcpy(&Value, Bytes + Offset, sizeof(Value));
		return Value;
	};
	if (Size < 24 || U32(0) != ChunkMagic || U32(4) != ChunkVersion)
	{
		return false;
	}
	const uint32 SectionCount = U32(20);
	if (SectionCount > 256)
	{
		return false;
	}

	UProceduralMeshComponent* Mesh = NewObject<UProceduralMeshComponent>(this);
	Mesh->bUseAsyncCooking = true;
	Mesh->SetMobility(EComponentMobility::Movable);
	Mesh->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
	Mesh->SetCollisionObjectType(ECC_WorldStatic);
	Mesh->SetCollisionResponseToAllChannels(ECR_Block);
	Mesh->SetupAttachment(RootComponent);
	// The component sits at the chunk's north-west corner; vertices are relative to it.
	Mesh->SetRelativeLocation(FVector(-(Key.Y - OriginY) * TileCm, (Key.X - OriginX) * TileCm, 0.0));
	Mesh->RegisterComponent();

	const bool bFlip = GetDefault<UEarthWalkSettings>()->bFlipTriangleWinding;
	const TArray<FVector2D> NoUVs;
	const TArray<FLinearColor> NoColors;
	const TArray<FProcMeshTangent> NoTangents;

	int64 Offset = 24;
	bool bOk = true;
	for (uint32 Section = 0; Section < SectionCount && bOk; ++Section)
	{
		if (Offset + 20 > Size)
		{
			bOk = false;
			break;
		}
		const uint32 Color = U32(Offset + 4);
		const uint32 Flags = U32(Offset + 8);
		const int64 NumVerts = U32(Offset + 12);
		const int64 NumIndices = U32(Offset + 16);
		Offset += 20;
		if (NumVerts > 4000000 || NumIndices > 12000000 || NumIndices % 3 != 0 || Offset + NumVerts * 24 + NumIndices * 4 > Size)
		{
			bOk = false;
			break;
		}

		TArray<float> Floats;
		Floats.SetNumUninitialized(NumVerts * 6);
		FMemory::Memcpy(Floats.GetData(), Bytes + Offset, NumVerts * 24);
		Offset += NumVerts * 24;

		TArray<FVector> Vertices;
		TArray<FVector> Normals;
		Vertices.SetNumUninitialized(NumVerts);
		Normals.SetNumUninitialized(NumVerts);
		const float* Pos = Floats.GetData();
		const float* Nrm = Pos + NumVerts * 3;
		for (int64 i = 0; i < NumVerts; ++i)
		{
			// File: u (east, 0..1), v (south, 0..1), height in metres.
			Vertices[i] = FVector(-Pos[i * 3 + 1] * TileCm, Pos[i * 3] * TileCm, Pos[i * 3 + 2] * 100.0);
			// File: east, north, up.
			Normals[i] = FVector(Nrm[i * 3 + 1], Nrm[i * 3], Nrm[i * 3 + 2]);
		}

		TArray<int32> Triangles;
		Triangles.SetNumUninitialized(NumIndices);
		FMemory::Memcpy(Triangles.GetData(), Bytes + Offset, NumIndices * 4);
		Offset += NumIndices * 4;
		for (int64 i = 0; i < NumIndices; ++i)
		{
			if (Triangles[i] < 0 || Triangles[i] >= NumVerts)
			{
				bOk = false;
				break;
			}
		}
		if (!bOk)
		{
			break;
		}
		if (bFlip)
		{
			for (int64 i = 0; i + 2 < NumIndices; i += 3)
			{
				Swap(Triangles[i + 1], Triangles[i + 2]);
			}
		}

		Mesh->CreateMeshSection_LinearColor(Section, Vertices, Triangles, Normals, NoUVs, NoColors, NoTangents, (Flags & FlagCollision) != 0);
		Mesh->SetMaterial(Section, MaterialFor(Color));
	}

	if (!bOk)
	{
		Mesh->DestroyComponent();
		return false;
	}
	Chunks.Add(Key, Mesh);
	return true;
}

void AEarthWorld::UpdateAvatars()
{
	const UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
	if (!Net)
	{
		return;
	}
	const TMap<FString, FEarthPeer>& Peers = Net->GetPeers();

	for (auto It = Avatars.CreateIterator(); It; ++It)
	{
		const FEarthPeer* Peer = Peers.Find(It.Key());
		if (!Peer || !Peer->bHasPosition)
		{
			if (It.Value())
			{
				It.Value()->Destroy();
			}
			It.RemoveCurrent();
		}
	}

	for (const TPair<FString, FEarthPeer>& Pair : Peers)
	{
		const FEarthPeer& Peer = Pair.Value;
		if (!Peer.bHasPosition)
		{
			continue;
		}
		TObjectPtr<AEarthWalkAvatar>& Avatar = Avatars.FindOrAdd(Pair.Key);
		const FVector Target = GeoToWorld(Peer.Lat, Peer.Lon, Peer.Alt);
		if (!Avatar)
		{
			Avatar = GetWorld()->SpawnActor<AEarthWalkAvatar>(Target, FRotator(0.0, Peer.Yaw, 0.0));
			if (Avatar)
			{
				Avatar->SetDisplayName(Peer.Name);
			}
		}
		if (Avatar)
		{
			Avatar->SetTarget(Target, Peer.Yaw);
		}
	}
}
