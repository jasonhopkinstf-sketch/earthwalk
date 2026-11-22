#include "EarthWorld.h"

#include "EarthChunkLabels.h"
#include "EarthCompany.h"
#include "EarthGeo.h"
#include "EarthGroundCover.h"
#include "EarthLife.h"
#include "EarthLifeMotion.h"
#include "EarthLook.h"
#include "EarthSounds.h"
#include "EarthPhotoWorld.h"
#include "EarthShowcase.h"
#include "EarthWalkAvatar.h"
#include "EarthWalkCharacter.h"
#include "EarthWalkNet.h"
#include "EarthWalkSettings.h"
#include "Camera/PlayerCameraManager.h"
#include "Components/CapsuleComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/GameInstance.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/Character.h"
#include "GameFramework/PlayerController.h"
#include "HttpModule.h"
#include "Interfaces/IHttpRequest.h"
#include "Interfaces/IHttpResponse.h"
#include "Engine/Texture.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"
#include "ProceduralMeshComponent.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr uint32 ChunkMagic = 0x31435745; // "EWC1"
	constexpr uint32 ChunkVersion = 1;
	constexpr uint32 FlagCollision = 1;
	constexpr int32 MaxRequestsInFlight = 4;
	constexpr int32 MaxLabelRequestsInFlight = 3;
	constexpr double LabelRetrySeconds = 120.0; // labels are optional, so failures are retried slowly
	constexpr double StoreyMeters = 3.0; // window row spacing; matches WallCode in EarthWalkAssetsCommandlet.cpp
	constexpr double WallSinkMeters = 0.6; // how far the server sinks walls below the ground (server/src/chunk.ts)
	constexpr int32 CoverCells = 512; // cells across a chunk in its cover map: a little under a metre each
	constexpr int32 TerrainGrid = 64; // terrain cells per chunk side (GRID in server/public/js/chunk.js)
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
	// Our own world unless asked: the photographic kinds are an opt-in (/world auto, /world photo).
	// -EWWorld=auto|photo|generated chooses for this run.
	EEarthWorldKind Wanted = EEarthWorldKind::Generated;
	FString Asked;
	if (FParse::Value(FCommandLine::Get(), TEXT("-EWWorld="), Asked))
	{
		Wanted = Asked.Equals(TEXT("photo"), ESearchCase::IgnoreCase) ? EEarthWorldKind::Photo
			: Asked.Equals(TEXT("auto"), ESearchCase::IgnoreCase) ? EEarthWorldKind::Auto
			: EEarthWorldKind::Generated;
	}
	FString Reason;
	if (!SetWorldKind(Wanted, Reason))
	{
		UE_LOG(LogTemp, Warning, TEXT("EarthWalk: %s"), *Reason);
	}
	GroundCover = GetWorld()->SpawnActor<AEarthGroundCover>();
	Life = GetWorld()->SpawnActor<AEarthLife>();
	Company = NewObject<UEarthCompany>(this);
	Company->Setup(this);
	Showcase = NewObject<UEarthShowcase>(this);
	Showcase->Setup(this);
	FString Sound;
	if (Life && Life->GetSounds() && FEarthWalkConfig::HasOverride(TEXT("Sound"), Sound) && Sound.Equals(TEXT("off"), ESearchCase::IgnoreCase))
	{
		Life->GetSounds()->SetEnabled(false);
	}
	// Checks for the living world, run without a person: see EarthLifeMotion.h and EarthSounds.h.
	FString TestFile;
	if (FParse::Value(FCommandLine::Get(), TEXT("-EWLifeTest="), TestFile))
	{
		EarthLife::RunSelfTest(TestFile);
		FPlatformMisc::RequestExit(false);
	}
	FString SoundFolder;
	if (FParse::Value(FCommandLine::Get(), TEXT("-EWSoundDump="), SoundFolder))
	{
		UEarthSounds::WriteWavFiles(SoundFolder);
	}
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
	OriginLon = Lon;
	OriginX = EarthGeo::LonToX(Lon);
	OriginY = EarthGeo::LatToY(Lat);
	TileCm = EarthGeo::MetersPerTile(Lat) * 100.0;
	++Generation;
	SetAerial(false); // a new place starts on the ground, in our own world

	for (const TPair<FIntPoint, TObjectPtr<UProceduralMeshComponent>>& Pair : Chunks)
	{
		if (Pair.Value)
		{
			Pair.Value->DestroyComponent();
		}
	}
	Chunks.Reset();
	CoverMaps.Reset();
	HeightMaps.Reset();
	WaterMaps.Reset();
	for (const TPair<FString, TObjectPtr<UProceduralMeshComponent>>& Pair : Interiors)
	{
		if (Pair.Value)
		{
			Pair.Value->DestroyComponent();
		}
	}
	Interiors.Reset();
	if (GroundCover)
	{
		GroundCover->Clear();
	}
	Pending.Reset();
	RetryAfter.Reset();
	ClearLabels();
	ChunkTimer = 0.f;

	if (WorldKind == EEarthWorldKind::Photo)
	{
		// The georeference moves first, so a new tileset starts loading in the right place.
		EarthPhoto::SetOrigin(GetWorld(), Lat, Lon);
		if (!PhotoTileset)
		{
			PhotoTileset = EarthPhoto::SpawnTileset(GetWorld(), FEarthWalkConfig::MapsKey(), /*bWalkable*/ true);
		}
		RestartPhotoWait();
		// Ask where the ground is here. The answer does not depend on the camera, which at this moment is
		// wherever the player happened to be, often below the photographic ground.
		bPhotoGroundKnown = false;
		const int32 AskedGeneration = Generation;
		EarthPhoto::SampleGround(GetWorld(), PhotoTileset, Lat, Lon, [WeakThis = TWeakObjectPtr<AEarthWorld>(this), AskedGeneration](bool bFound, double Z)
		{
			AEarthWorld* Self = WeakThis.Get();
			if (Self && Self->IsPhotoWorld() && Self->Generation == AskedGeneration && bFound)
			{
				Self->bPhotoGroundKnown = true;
				Self->PhotoGroundZ = Z;
			}
		});
	}
	else if (WorldKind == EEarthWorldKind::Auto)
	{
		// The gap between sea level and the ellipsoid is different here, so it is measured again.
		bAerialAligned = false;
		bAerialSampling = false;
		AerialRetryAfter = 0.0;
		AerialAboveSince = 0.0;
		if (PhotoTileset)
		{
			EarthPhoto::SetOrigin(GetWorld(), Lat, Lon);
		}
	}
}

bool AEarthWorld::PhotoGroundAtOrigin(double& OutZ) const
{
	OutZ = PhotoGroundZ;
	return IsPhotoWorld() && bPhotoGroundKnown;
}

void AEarthWorld::RestartPhotoWait()
{
	PhotoSince = FPlatformTime::Seconds();
	bPhotoReady = false;
}

bool AEarthWorld::SetWorldKind(EEarthWorldKind NewKind, FString& OutReason)
{
	if (NewKind != EEarthWorldKind::Generated)
	{
		if (!EarthPhoto::IsBuiltIn())
		{
			OutReason = TEXT("The photographic world needs the Cesium for Unreal plugin, which this build does not have.");
			return false;
		}
		if (FEarthWalkConfig::MapsKey().IsEmpty())
		{
			OutReason = TEXT("The photographic world needs a Google Map Tiles key. Type /mapskey <key> first.");
			return false;
		}
	}
	if (NewKind != WorldKind)
	{
		// The two photographic kinds want different tilesets (only one is walked on), so each starts afresh.
		SetAerial(false);
		if (PhotoTileset)
		{
			PhotoTileset->Destroy();
			PhotoTileset = nullptr;
		}
		bAerialSuspended = true;
		bAerialAligned = false;
		bAerialSampling = false;
	}
	WorldKind = NewKind;
	bPhotoGroundKnown = false;
	return true;
}

void AEarthWorld::ClearLabels()
{
	for (const TPair<FIntPoint, TObjectPtr<AEarthChunkLabels>>& Pair : Labels)
	{
		if (Pair.Value)
		{
			Pair.Value->Destroy();
		}
	}
	Labels.Reset();
	PendingLabels.Reset();
	LabelRetryAfter.Reset();
	Doors.Reset();
	if (Life)
	{
		Life->Clear();
	}
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
	if (WorldKind == EEarthWorldKind::Photo)
	{
		// Tiles arrive coarse first and sharpen; wait for most of them so the player lands on the real
		// street rather than on a rough stand-in, but never wait for ever.
		if (!bPhotoReady)
		{
			const double Waited = FPlatformTime::Seconds() - PhotoSince;
			bPhotoReady = Waited > 3.0 && (EarthPhoto::LoadProgress(PhotoTileset) >= 95.f || Waited > 30.0);
		}
		return bPhotoReady;
	}
	return Chunks.Contains(ChunkAt(Position));
}

bool AEarthWorld::TerrainHeightAt(double EastM, double SouthM, double& OutMeters) const
{
	// The same sum as terrainHeight in server/public/js/chunk.js: each lattice cell is two triangles.
	const double U = OriginX + EastM * 100.0 / TileCm;
	const double V = OriginY + SouthM * 100.0 / TileCm;
	const FIntPoint Key(FMath::FloorToInt32(U), FMath::FloorToInt32(V));
	const TArray<float>* Heights = HeightMaps.Find(Key);
	if (!Heights)
	{
		return false;
	}
	const double Gx = FMath::Min(TerrainGrid - 1e-6, FMath::Max(0.0, (U - Key.X) * TerrainGrid));
	const double Gy = FMath::Min(TerrainGrid - 1e-6, FMath::Max(0.0, (V - Key.Y) * TerrainGrid));
	const int32 I = FMath::FloorToInt32(Gx);
	const int32 J = FMath::FloorToInt32(Gy);
	const double Fu = Gx - I;
	const double Fv = Gy - J;
	const int32 W = TerrainGrid + 1;
	const double H00 = (*Heights)[J * W + I];
	const double H11 = (*Heights)[(J + 1) * W + I + 1];
	if (Fu >= Fv)
	{
		const double H10 = (*Heights)[J * W + I + 1];
		OutMeters = H00 + Fu * (H10 - H00) + Fv * (H11 - H10);
	}
	else
	{
		const double H01 = (*Heights)[(J + 1) * W + I];
		OutMeters = H00 + Fv * (H01 - H00) + Fu * (H11 - H01);
	}
	return true;
}

bool AEarthWorld::WaterAt(double EastM, double SouthM, bool& bOutWet) const
{
	const double U = OriginX + EastM * 100.0 / TileCm;
	const double V = OriginY + SouthM * 100.0 / TileCm;
	const FIntPoint Key(FMath::FloorToInt32(U), FMath::FloorToInt32(V));
	const TArray<uint8>* Water = WaterMaps.Find(Key);
	if (!Water)
	{
		return false;
	}
	const int32 X = FMath::Min(TerrainGrid - 1, FMath::FloorToInt32((U - Key.X) * TerrainGrid));
	const int32 Y = FMath::Min(TerrainGrid - 1, FMath::FloorToInt32((V - Key.Y) * TerrainGrid));
	bOutWet = (*Water)[Y * TerrainGrid + X] == 1;
	return true;
}

void AEarthWorld::DoorsNear(double EastM, double SouthM, double ReachM, TArray<FEarthDoor>& Out) const
{
	for (const TPair<FIntPoint, TArray<FEarthDoor>>& Pair : Doors)
	{
		for (const FEarthDoor& Door : Pair.Value)
		{
			if (FMath::Abs(Door.X - EastM) <= ReachM && FMath::Abs(Door.Z - SouthM) <= ReachM && Chunks.Contains(Door.Chunk))
			{
				Out.Add(Door);
			}
		}
	}
}

namespace
{
	FString InteriorName(FIntPoint Key, int64 Id)
	{
		return FString::Printf(TEXT("%d/%d/%lld"), Key.X, Key.Y, Id);
	}
}

void AEarthWorld::ForgetInteriors(FIntPoint Key)
{
	const FString Prefix = FString::Printf(TEXT("%d/%d/"), Key.X, Key.Y);
	for (auto It = Interiors.CreateIterator(); It; ++It)
	{
		if (It.Key().StartsWith(Prefix))
		{
			if (It.Value())
			{
				It.Value()->DestroyComponent();
			}
			It.RemoveCurrent();
		}
	}
}

void AEarthWorld::OpenHouse(const FEarthDoor& Door, TFunction<void(bool bOpen, const FString& Why)> Done)
{
	if (Interiors.Contains(InteriorName(Door.Chunk, Door.Id)))
	{
		Done(true, FString());
		return;
	}
	const int32 WrappedX = ((Door.Chunk.X % 65536) + 65536) % 65536;
	const TSharedRef<IHttpRequest, ESPMode::ThreadSafe> Request = FHttpModule::Get().CreateRequest();
	Request->SetURL(FString::Printf(TEXT("%s/v1/interior/%d/%d/%d/%lld"), *FEarthWalkConfig::ServerUrl(), EarthGeo::ChunkZoom, WrappedX, Door.Chunk.Y, Door.Id));
	Request->SetVerb(TEXT("GET"));
	Request->SetTimeout(30.f);
	if (const FString Code = FEarthWalkConfig::AccessCode(); !Code.IsEmpty())
	{
		Request->SetHeader(TEXT("Authorization"), TEXT("Bearer ") + Code);
	}
	const int32 RequestGeneration = Generation;
	const FIntPoint Key = Door.Chunk;
	const int64 Id = Door.Id;
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Key, Id, RequestGeneration, Done](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
	{
		if (RequestGeneration != Generation || !Chunks.Contains(Key))
		{
			Done(false, FString()); // the player has gone somewhere else meanwhile
			return;
		}
		const bool bGot = bConnected && Response.IsValid() && Response->GetResponseCode() == 200;
		if (bGot && (Interiors.Contains(InteriorName(Key, Id)) || BuildInterior(Key, Id, Response->GetContent())))
		{
			Done(true, FString());
			return;
		}
		Done(false, Response.IsValid() && Response->GetResponseCode() == 404 ? FString(TEXT("This door is stuck.")) : FString(TEXT("The door would not open just now. Try again in a moment.")));
	});
	Request->ProcessRequest();
}

/**
 * Builds the inside of a house from the server's answer, which is in the chunk format and in the
 * chunk's own coordinates, so it sits inside the house's real walls. Walls, floors and furniture are
 * single sheets, so each is given a second face looking the other way.
 */
bool AEarthWorld::BuildInterior(FIntPoint Key, int64 Id, const TArray<uint8>& Data)
{
	const uint8* Bytes = Data.GetData();
	const int64 Size = Data.Num();
	const auto U32 = [Bytes](int64 Offset)
	{
		uint32 Value;
		FMemory::Memcpy(&Value, Bytes + Offset, sizeof(Value));
		return Value;
	};
	if (Size < 24 || U32(0) != ChunkMagic || U32(4) != ChunkVersion || U32(20) > 256)
	{
		return false;
	}
	const uint32 SectionCount = U32(20);

	UProceduralMeshComponent* Mesh = NewObject<UProceduralMeshComponent>(this);
	Mesh->bUseAsyncCooking = false; // the floor has to be there the moment the player steps in
	Mesh->SetMobility(EComponentMobility::Movable);
	Mesh->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
	Mesh->SetCollisionObjectType(ECC_WorldStatic);
	Mesh->SetCollisionResponseToAllChannels(ECR_Block);
	Mesh->SetupAttachment(RootComponent);
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
		const uint32 SurfaceId = U32(Offset);
		const uint32 Color = U32(Offset + 4);
		const uint32 Flags = U32(Offset + 8);
		const int64 NumVerts = U32(Offset + 12);
		const int64 NumIndices = U32(Offset + 16);
		Offset += 20;
		if (NumVerts > 1000000 || NumIndices > 3000000 || NumIndices % 3 != 0 || Offset + NumVerts * 24 + NumIndices * 4 > Size)
		{
			bOk = false;
			break;
		}
		TArray<float> Floats;
		Floats.SetNumUninitialized(NumVerts * 6);
		FMemory::Memcpy(Floats.GetData(), Bytes + Offset, NumVerts * 24);
		Offset += NumVerts * 24;
		const float* Pos = Floats.GetData();
		const float* Nrm = Pos + NumVerts * 3;
		TArray<FVector> Vertices;
		TArray<FVector> Normals;
		Vertices.Reserve(NumVerts * 2);
		Normals.Reserve(NumVerts * 2);
		for (int64 i = 0; i < NumVerts; ++i)
		{
			// File: u (east, 0..1), v (south, 0..1), height in metres; normals east, north, up.
			Vertices.Add(FVector(-Pos[i * 3 + 1] * TileCm, Pos[i * 3] * TileCm, Pos[i * 3 + 2] * 100.0));
			Normals.Add(FVector(Nrm[i * 3 + 1], Nrm[i * 3], Nrm[i * 3 + 2]));
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
		// The second face: the same corners the other way round, looking the other way.
		for (int64 i = 0; i < NumVerts; ++i)
		{
			Vertices.Add(FVector(Vertices[i]));
			Normals.Add(-FVector(Normals[i]));
		}
		Triangles.Reserve(NumIndices * 2);
		for (int64 i = 0; i + 2 < NumIndices; i += 3)
		{
			const int32 A = Triangles[i], B = Triangles[i + 1], C = Triangles[i + 2];
			Triangles.Add(static_cast<int32>(A + NumVerts));
			Triangles.Add(static_cast<int32>(C + NumVerts));
			Triangles.Add(static_cast<int32>(B + NumVerts));
		}
		Mesh->CreateMeshSection_LinearColor(Section, Vertices, Triangles, Normals, NoUVs, NoUVs, NoUVs, NoUVs, NoColors, NoTangents, (Flags & FlagCollision) != 0);
		Mesh->SetMaterial(Section, MaterialForSurface(SurfaceId, Color));
	}
	if (!bOk)
	{
		Mesh->DestroyComponent();
		return false;
	}
	Mesh->SetVisibility(!bAerial);
	Interiors.Add(InteriorName(Key, Id), Mesh);
	return true;
}

AEarthWalkAvatar* AEarthWorld::FindAvatar(const FString& Id) const
{
	const TObjectPtr<AEarthWalkAvatar>* Found = Avatars.Find(Id);
	return Found ? Found->Get() : nullptr;
}

void AEarthWorld::HomeCirclesIn(const FBox2D& Area, TArray<FVector>& OutCentreAndRadius) const
{
	if (Life)
	{
		Life->HomeCirclesIn(Area, OutCentreAndRadius);
	}
}

uint8 AEarthWorld::CoverAt(const FVector& Position) const
{
	const double U = OriginX + Position.Y / TileCm;
	const double V = OriginY - Position.X / TileCm;
	const FIntPoint Key(FMath::FloorToInt32(U), FMath::FloorToInt32(V));
	const TArray<uint8>* Map = CoverMaps.Find(Key);
	if (!Map)
	{
		return EarthCover::Unknown;
	}
	const int32 X = FMath::Clamp(static_cast<int32>((U - Key.X) * CoverCells), 0, CoverCells - 1);
	const int32 Y = FMath::Clamp(static_cast<int32>((V - Key.Y) * CoverCells), 0, CoverCells - 1);
	return (*Map)[Y * CoverCells + X];
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
		UpdateAerial(Player);
		if (GroundCover && !bAerial)
		{
			GroundCover->Update(this, Player->GetActorLocation());
		}
	}

	// Tell the room where we are, ten times a second.
	SendTimer -= DeltaSeconds;
	if (SendTimer <= 0.f)
	{
		SendTimer = 0.1f;
		if (UEarthWalkNet* Net = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr)
		{
			// On a mount, the room is told where the seat is, so the figure others see sits on top of it.
			const AEarthWalkCharacter* Rider = Cast<AEarthWalkCharacter>(Player);
			const FVector Feet = Player->GetActorLocation() - FVector(0, 0, Player->GetCapsuleComponent()->GetScaledCapsuleHalfHeight() - (Rider ? Rider->SeatLiftCm() : 0.0));
			double Lat, Lon, Alt;
			WorldToGeo(Feet, Lat, Lon, Alt);
			Net->SendPosition(Lat, Lon, Alt, Rider ? Rider->FacingYaw() : Controller->GetControlRotation().Yaw);
		}
	}

	UpdateAvatars();

	// "Show me": a player on the way to something to show is stood beside it once the world there has arrived.
	if (Showcase)
	{
		const UEarthWalkNet* ShowClock = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
		static const double ShowShift = []() { double Shift = 0.0; FParse::Value(FCommandLine::Get(), TEXT("-EWTimeShift="), Shift); return Shift; }();
		Showcase->Frame(Cast<AEarthWalkCharacter>(Controller->GetPawn()), (ShowClock ? ShowClock->Now() : UEarthWalkNet::LocalNow()) + ShowShift);
	}

	// The living world moves every frame, by the room's clock. It keeps to the ground, so it is put
	// away while the photographic view from the air is up.
	if (Life && !bAerial)
	{
		TArray<FVector> Everyone;
		Everyone.Add(Player->GetActorLocation() - FVector(0, 0, Player->GetCapsuleComponent()->GetScaledCapsuleHalfHeight()));
		for (const TPair<FString, TObjectPtr<AEarthWalkAvatar>>& Pair : Avatars)
		{
			if (Pair.Value)
			{
				Everyone.Add(Pair.Value->GetActorLocation());
			}
		}
		const UEarthWalkNet* Clock = GetGameInstance() ? GetGameInstance()->GetSubsystem<UEarthWalkNet>() : nullptr;
		const FVector Ears = Controller->PlayerCameraManager ? Controller->PlayerCameraManager->GetCameraLocation() : Player->GetActorLocation();
		// -EWTimeShift=<seconds> moves this game's clock, for taking a picture of a moment that is not now (a train passing).
		static const double TimeShift = []() { double Shift = 0.0; FParse::Value(FCommandLine::Get(), TEXT("-EWTimeShift="), Shift); return Shift; }();
		const double SharedTime = (Clock ? Clock->Now() : UEarthWalkNet::LocalNow()) + TimeShift;
		// Riding, talking and things doing as they were told come first: they say what is not where its timetable has it.
		if (Company)
		{
			Company->Frame(Cast<AEarthWalkCharacter>(Controller->GetPawn()), FMath::Min(0.25, static_cast<double>(DeltaSeconds)), SharedTime);
		}
		Life->Update(this, DeltaSeconds, SharedTime, Everyone, Ears);
	}
}

void AEarthWorld::UpdateChunks(const FVector& Around)
{
	if (WorldKind == EEarthWorldKind::Photo)
	{
		return; // the photographic tiles stand in for our own chunks, which SetOrigin has dropped
	}
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
			CoverMaps.Remove(It.Key());
			HeightMaps.Remove(It.Key());
			WaterMaps.Remove(It.Key());
			ForgetInteriors(It.Key());
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

	UpdateLabels(Center);
}

/** Letterboxes and street signs for the nearest loaded chunks; they follow the chunks in and out. */
void AEarthWorld::UpdateLabels(FIntPoint Center)
{
	const int32 Radius = FMath::Clamp(GetDefault<UEarthWalkSettings>()->LabelRadiusChunks, 0, 3);

	for (auto It = Labels.CreateIterator(); It; ++It)
	{
		const FIntPoint Delta = It.Key() - Center;
		if (FMath::Max(FMath::Abs(Delta.X), FMath::Abs(Delta.Y)) > Radius + 1 || !Chunks.Contains(It.Key()))
		{
			if (It.Value())
			{
				It.Value()->Destroy();
			}
			if (Life)
			{
				Life->RemoveChunk(It.Key());
			}
			It.RemoveCurrent();
		}
	}

	TArray<FIntPoint> Wanted;
	const double Now = FPlatformTime::Seconds();
	for (int32 DY = -Radius; DY <= Radius; ++DY)
	{
		for (int32 DX = -Radius; DX <= Radius; ++DX)
		{
			const FIntPoint Key(Center.X + DX, Center.Y + DY);
			if (!Chunks.Contains(Key) || Labels.Contains(Key) || PendingLabels.Contains(Key))
			{
				continue;
			}
			if (const double* Until = LabelRetryAfter.Find(Key))
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
		if (PendingLabels.Num() >= MaxLabelRequestsInFlight)
		{
			break;
		}
		RequestLabels(Key);
	}
}

void AEarthWorld::RequestLabels(FIntPoint Key)
{
	PendingLabels.Add(Key);
	const int32 WrappedX = ((Key.X % 65536) + 65536) % 65536;
	const FString Url = FString::Printf(TEXT("%s/v1/labels/%d/%d/%d"), *FEarthWalkConfig::ServerUrl(), EarthGeo::ChunkZoom, WrappedX, Key.Y);

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
			return;
		}
		PendingLabels.Remove(Key);

		// Anything but a good reply (an older server says 404, a busy one 429) is dropped quietly.
		bool bOk = false;
		if (bConnected && Response.IsValid() && Response->GetResponseCode() == 200)
		{
			TSharedPtr<FJsonObject> Json;
			const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Response->GetContentAsString());
			const TArray<TSharedPtr<FJsonValue>>* Items = nullptr;
			if (FJsonSerializer::Deserialize(Reader, Json) && Json.IsValid() && Json->TryGetArrayField(TEXT("items"), Items))
			{
				bOk = true;
				const TObjectPtr<UProceduralMeshComponent>* Mesh = Chunks.Find(Key);
				if (Mesh && *Mesh && !Labels.Contains(Key))
				{
					if (AEarthChunkLabels* Actor = GetWorld()->SpawnActor<AEarthChunkLabels>(FVector::ZeroVector, FRotator::ZeroRotator))
					{
						Actor->Build(*Items, (*Mesh)->GetComponentLocation(), TileCm, this);
						Actor->SetActorHiddenInGame(bAerial);
						Labels.Add(Key, Actor);
					// Front doors that open: E beside one goes in (UEarthCompany).
						TArray<FEarthDoor>& ChunkDoors = Doors.FindOrAdd(Key);
						ChunkDoors.Reset();
						for (const TSharedPtr<FJsonValue>& Value : *Items)
						{
							const TSharedPtr<FJsonObject>* Item = nullptr;
							FString Kind;
							double U = 0.0, V = 0.0, Id = 0.0;
							FEarthDoor Door;
							if (Value.IsValid() && Value->TryGetObject(Item) && (*Item)->TryGetStringField(TEXT("kind"), Kind) && Kind == TEXT("door")
								&& (*Item)->TryGetNumberField(TEXT("u"), U) && (*Item)->TryGetNumberField(TEXT("v"), V) && (*Item)->TryGetNumberField(TEXT("h"), Door.H)
								&& (*Item)->TryGetNumberField(TEXT("yaw"), Door.Yaw) && (*Item)->TryGetNumberField(TEXT("id"), Id))
							{
								Door.Chunk = Key;
								Door.Id = static_cast<int64>(Id);
								Door.X = (Key.X - OriginX + U) * TileCm / 100.0;
								Door.Z = (Key.Y - OriginY + V) * TileCm / 100.0;
								ChunkDoors.Add(Door);
							}
						}
						if (Life)
						{
							// The same reply says where the animals live and what the cars and trains do.
							Life->AddChunk(Key, *Items, OriginX, OriginY, TileCm / 100.0);
							// Crops already planted where a herd turns out to roam are taken up again.
							TArray<FVector> Circles;
							Life->HomeCircles(Key, Circles);
							for (const FVector& Circle : Circles)
							{
								if (GroundCover)
								{
									GroundCover->Replant(FVector2D(Circle.X, Circle.Y), Circle.Z);
								}
							}
						}
					}
				}
			}
		}
		if (!bOk)
		{
			LabelRetryAfter.Add(Key, FPlatformTime::Seconds() + LabelRetrySeconds);
		}
	});
	Request->ProcessRequest();
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
	const double Asked = FPlatformTime::Seconds();
	Request->OnProcessRequestComplete().BindWeakLambda(this, [this, Key, RequestGeneration, Asked](FHttpRequestPtr, FHttpResponsePtr Response, bool bConnected)
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
		// Say what is really going on: every case below is tried again in ten seconds.
		if (!bConnected || !Response.IsValid())
		{
			// No answer after a long wait is a server that is there but busy (building a place nobody has
			// been to, or waking up); no answer at once is no server, or no internet.
			LastError = FPlatformTime::Seconds() - Asked > 30.0
				? FString(TEXT("The world server is slow just now: a new place can take a minute or two to build. Still trying..."))
				: FString::Printf(TEXT("Cannot reach the world server at %s. Is the internet working? Still trying..."), *FEarthWalkConfig::ServerUrl());
		}
		else if (Response->GetResponseCode() == 401)
		{
			LastError = TEXT("The world server needs an access code. Type /code <code>");
		}
		else if (Response->GetResponseCode() == 429)
		{
			LastError = TEXT("You are exploring faster than the world can be built. It will catch up in a moment...");
		}
		else
		{
			LastError = FString::Printf(TEXT("The world server could not build part of this area just now (HTTP %d). Still trying..."), Response->GetResponseCode());
		}
		RetryAfter.Add(Key, FPlatformTime::Seconds() + 10.0);
	});
	Request->ProcessRequest();
}

namespace
{
	/**
	 * How each server surface id is drawn: which master material, in what colour, with which drawn
	 * pattern. Ground and roads take their colour from here, the barnyard palette (bright, warm, a
	 * picture-book farm), instead of the server's, which the browser still uses. Buildings keep the
	 * server's colour: it paints every house its own. The flat look (EarthLook.h) has its own, brighter
	 * colour for each of the ground's.
	 */
	struct FSurfaceStyle
	{
		const TCHAR* Master; // asset name under /Game/EarthWalk/Materials
		uint32 Color; // 0xRRGGBB, or 0 to use the colour the server sent
		float Pattern; // M_EarthTop: 0 plain, 1 roof tiles, 2 furrows, 3 paving slabs, 4 grass strokes, 5 hedge leaves, 6 pickets
		float Windows; // M_EarthWall
		float Bricks; // M_EarthWall: patches of drawn brick
		float Homely; // M_EarthWall: somebody's house, so some get shutters and some boxes of flowers
		uint32 FlatColor = 0; // the flat look's colour for this surface, or 0 for the same as the barnyard look's
	};

	const FSurfaceStyle* StyleFor(uint32 SurfaceId)
	{
		static const TMap<uint32, FSurfaceStyle> Styles = {
			// Ground cover (server/src/chunk.ts MATERIALS)
			{ 0, { TEXT("M_EarthTop"), 0x7fc04f, 4.f, 0.f, 0.f, 0.f, 0x79d23c } }, // unclassified land: meadow
			{ 1, { TEXT("M_EarthTop"), 0x63b944, 4.f, 0.f, 0.f, 0.f, 0x5cc832 } }, // parks and grass
			{ 2, { TEXT("M_EarthTop"), 0x4e9a3e, 0.f, 0.f, 0.f, 0.f, 0x3f9f35 } }, // forest floor
			{ 3, { TEXT("M_EarthTop"), 0xe6c85a, 2.f, 0.f, 0.f, 0.f, 0xf0d660 } }, // farmland: wheat gold, furrowed
			{ 4, { TEXT("M_EarthTop"), 0xf3e2a6, 0.f, 0.f, 0.f, 0.f, 0xf9e79f } }, // sand
			{ 5, { TEXT("M_EarthTop"), 0x88c653, 4.f, 0.f, 0.f, 0.f, 0x86d94a } }, // residential land: lawns
			{ 6, { TEXT("M_EarthTop"), 0xcbc4b4, 3.f, 0.f, 0.f, 0.f, 0xd9d4c8 } }, // paved
			{ 7, { TEXT("M_EarthWater"), 0x4aa8e0, 0.f, 0.f, 0.f, 0.f, 0x3aa8f2 } },
			{ 8, { TEXT("M_EarthTop"), 0xa59c90, 0.f, 0.f, 0.f, 0.f, 0xaaa59c } }, // rock
			// Roads
			{ 10, { TEXT("M_EarthTop"), 0x7f838c, 0.f, 0.f, 0.f, 0.f, 0x8d919c } },
			{ 11, { TEXT("M_EarthTop"), 0xe6c690, 0.f, 0.f, 0.f, 0.f, 0xefcb8a } }, // paths
			{ 12, { TEXT("M_EarthTop"), 0x7a5e4a, 0.f, 0.f, 0.f, 0.f, 0x80593f } }, // railway
			{ 13, { TEXT("M_EarthWater"), 0x4aa8e0, 0.f, 0.f, 0.f, 0.f, 0x3aa8f2 } }, // streams
			{ 14, { TEXT("M_EarthTop"), 0xd9d2c0, 3.f, 0.f, 0.f, 0.f, 0xe6e1d5 } }, // pavements
			{ 15, { TEXT("M_EarthTop"), 0xf7f4ea, 0.f, 0.f, 0.f, 0.f, 0xffffff } }, // road markings
			// Building walls, with windows, in the server's paint
			{ 20, { TEXT("M_EarthWall"), 0, 0.f, 1.f, 0.f, 1.f } }, // painted houses
			{ 21, { TEXT("M_EarthWall"), 0, 0.f, 1.f, 0.f, 0.f } }, // large painted buildings
			{ 22, { TEXT("M_EarthWall"), 0, 0.f, 1.f, 0.f, 0.f } }, // large concrete buildings
			{ 23, { TEXT("M_EarthWall"), 0, 0.f, 1.f, 1.f, 1.f } }, // brick houses
			// Roofs
			{ 24, { TEXT("M_EarthTop"), 0, 1.f, 0.f, 0.f, 0.f } },
			{ 25, { TEXT("M_EarthTop"), 0, 1.f, 0.f, 0.f, 0.f } },
			// Doors, woodwork (frames, steps, porch posts, the undersides of eaves) and chimneys
			{ 26, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 27, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 28, { TEXT("M_EarthWall"), 0, 0.f, 0.f, 1.f, 0.f } },
			// Gardens
			{ 32, { TEXT("M_EarthTop"), 0x45a548, 5.f, 0.f, 0.f, 0.f, 0x3bae42 } }, // hedges
			{ 33, { TEXT("M_EarthFence"), 0xf6f3ea, 0.f, 0.f, 0.f, 0.f, 0xffffff } }, // picket fences
			// Inside houses: floors, walls, ceilings, furniture, windows and frames, rugs, each in the server's colour
			{ 40, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 41, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 42, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 43, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 44, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
			{ 45, { TEXT("M_EarthTop"), 0, 0.f, 0.f, 0.f, 0.f } },
		};
		return Styles.Find(SurfaceId);
	}

	template <class T>
	T* LoadArt(const TCHAR* Folder, const FString& Name)
	{
		return LoadObject<T>(nullptr, *FString::Printf(TEXT("/Game/EarthWalk/%s/%s.%s"), Folder, *Name, *Name));
	}

	/**
	 * Paints one of the world's materials for the look in use: its colour (the surface's own in that
	 * look, or the one the server sent) and how flat it is drawn. Called when a material is made, and
	 * again for all of them when the look changes. Leaves and bark (ids from 100) keep their colour.
	 */
	void PaintForLook(UMaterialInstanceDynamic* Material, uint32 SurfaceId, uint32 Rgba)
	{
		if (const FSurfaceStyle* Style = StyleFor(SurfaceId))
		{
			const uint32 Own = EarthLook::Current() == EEarthLook::Flat && Style->FlatColor ? Style->FlatColor : Style->Color;
			const uint32 Rgb = Own ? Own : (Rgba >> 8);
			const FColor Color((Rgb >> 16) & 0xff, (Rgb >> 8) & 0xff, Rgb & 0xff, 255);
			Material->SetVectorParameterValue(TEXT("Color"), FLinearColor::FromSRGBColor(Color));
		}
		EarthLook::PaintSurface(Material);
	}
}

void AEarthWorld::ApplyLook()
{
	for (const TPair<uint64, TObjectPtr<UMaterialInstanceDynamic>>& Pair : SurfaceMaterials)
	{
		if (Pair.Value)
		{
			PaintForLook(Pair.Value, static_cast<uint32>(Pair.Key >> 32), static_cast<uint32>(Pair.Key & 0xffffffffu));
		}
	}
}

UMaterialInstanceDynamic* AEarthWorld::MaterialForSurface(uint32 SurfaceId, uint32 Rgba)
{
	const uint64 Key = (static_cast<uint64>(SurfaceId) << 32) | Rgba;
	if (const TObjectPtr<UMaterialInstanceDynamic>* Found = SurfaceMaterials.Find(Key))
	{
		return *Found;
	}
	const FSurfaceStyle* Style = StyleFor(SurfaceId);
	UMaterialInterface* Master = Style ? LoadArt<UMaterialInterface>(TEXT("Materials"), Style->Master) : nullptr;
	if (!Master)
	{
		return MaterialFor(Rgba); // trees, or the art assets have not been built yet
	}
	UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(Master, this);
	if (Material)
	{
		PaintForLook(Material, SurfaceId, Rgba);
		Material->SetScalarParameterValue(TEXT("Pattern"), Style->Pattern);
		Material->SetScalarParameterValue(TEXT("Windows"), Style->Windows);
		Material->SetScalarParameterValue(TEXT("Bricks"), Style->Bricks);
		Material->SetScalarParameterValue(TEXT("Homely"), Style->Homely);
	}
	SurfaceMaterials.Add(Key, Material);
	return Material;
}

UMaterialInstanceDynamic* AEarthWorld::MaterialForFoliage(uint32 Rgba, float Fluff, int32 SwayCm, bool bSmall)
{
	const uint64 Key = (static_cast<uint64>((Fluff > 0.5f ? 101 : 100) + (bSmall ? 2 : 0) + 16 * FMath::Clamp(SwayCm, 0, 60)) << 32) | Rgba;
	if (const TObjectPtr<UMaterialInstanceDynamic>* Found = SurfaceMaterials.Find(Key))
	{
		return *Found;
	}
	UMaterialInterface* Master = LoadArt<UMaterialInterface>(TEXT("Materials"), TEXT("M_EarthFoliage"));
	if (!Master)
	{
		return MaterialFor(Rgba);
	}
	UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(Master, this);
	if (Material)
	{
		const FColor Color((Rgba >> 24) & 0xff, (Rgba >> 16) & 0xff, (Rgba >> 8) & 0xff, 255);
		Material->SetVectorParameterValue(TEXT("Color"), FLinearColor::FromSRGBColor(Color));
		Material->SetScalarParameterValue(TEXT("Fluff"), Fluff);
		Material->SetScalarParameterValue(TEXT("Sway"), static_cast<float>(SwayCm));
		Material->SetScalarParameterValue(TEXT("Sheen"), bSmall ? 0.02f : 0.08f);
		EarthLook::PaintSurface(Material);
	}
	SurfaceMaterials.Add(Key, Material);
	return Material;
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

	// What covers the ground, cell by cell, for AEarthGroundCover. Sections arrive ground first, then
	// roads, then buildings, so whatever lies on top of the ground is drawn over it.
	TArray<uint8> Cover;
	Cover.SetNumZeroed(CoverCells * CoverCells);
	// The bare terrain, for standing animals and cars on: every ground vertex sits on a lattice point.
	TArray<float> Heights;
	Heights.SetNumZeroed((TerrainGrid + 1) * (TerrainGrid + 1));
	// Which cells of the terrain are water, from where its triangles lie: boats keep to it, and nothing else may be ridden across.
	TArray<uint8> Water;
	Water.SetNumZeroed(TerrainGrid * TerrainGrid);

	int64 Offset = 24;
	bool bOk = true;
	for (uint32 Section = 0; Section < SectionCount && bOk; ++Section)
	{
		if (Offset + 20 > Size)
		{
			bOk = false;
			break;
		}
		const uint32 SurfaceId = U32(Offset);
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
		if (SurfaceId == 30)
		{
			// The server's cone trees are for the browser; this client grows its own from the labels route.
			Offset += NumVerts * 24 + NumIndices * 4;
			continue;
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

		if (SurfaceId <= 8)
		{
			for (int64 i = 0; i < NumVerts; ++i)
			{
				const int32 Gi = FMath::RoundToInt32(Pos[i * 3] * TerrainGrid);
				const int32 Gj = FMath::RoundToInt32(Pos[i * 3 + 1] * TerrainGrid);
				if (Gi >= 0 && Gi <= TerrainGrid && Gj >= 0 && Gj <= TerrainGrid)
				{
					Heights[Gj * (TerrainGrid + 1) + Gi] = Pos[i * 3 + 2];
				}
			}
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
		if (SurfaceId == 7)
		{
			// Open water (WATER in server/public/js/world.js): mark the cell under the middle of each triangle.
			for (int64 i = 0; i + 2 < NumIndices; i += 3)
			{
				const float* A = Pos + Triangles[i] * 3;
				const float* B = Pos + Triangles[i + 1] * 3;
				const float* C = Pos + Triangles[i + 2] * 3;
				const int32 X = FMath::Clamp(FMath::FloorToInt32((A[0] + B[0] + C[0]) / 3.f * TerrainGrid), 0, TerrainGrid - 1);
				const int32 Y = FMath::Clamp(FMath::FloorToInt32((A[1] + B[1] + C[1]) / 3.f * TerrainGrid), 0, TerrainGrid - 1);
				Water[Y * TerrainGrid + X] = 1;
			}
		}

		// Draw this section into the cover map: every cell whose middle a triangle lies over.
		{
			const uint8 Code = SurfaceId == 0 || SurfaceId == 1 || SurfaceId == 5 ? EarthCover::Grass
				: SurfaceId == 2 ? EarthCover::Forest
				: SurfaceId == 3 ? EarthCover::Farm
				: EarthCover::Blocked;
			for (int64 i = 0; i + 2 < NumIndices; i += 3)
			{
				const float* A = Pos + Triangles[i] * 3;
				const float* B = Pos + Triangles[i + 1] * 3;
				const float* C = Pos + Triangles[i + 2] * 3;
				const double Ax = A[0] * CoverCells, Ay = A[1] * CoverCells;
				const double Bx = B[0] * CoverCells, By = B[1] * CoverCells;
				const double Cx = C[0] * CoverCells, Cy = C[1] * CoverCells;
				if (Code == EarthCover::Blocked)
				{
					// Thin things (a fence, a door step) may cover no cell's middle: mark their corners at least.
					for (const float* P : { A, B, C })
					{
						const int32 X = static_cast<int32>(P[0] * CoverCells), Y = static_cast<int32>(P[1] * CoverCells);
						if (X >= 0 && X < CoverCells && Y >= 0 && Y < CoverCells)
						{
							Cover[Y * CoverCells + X] = Code;
						}
					}
				}
				const double Area = (Bx - Ax) * (Cy - Ay) - (By - Ay) * (Cx - Ax);
				if (FMath::Abs(Area) < 1e-4)
				{
					continue; // upright, as walls are
				}
				const int32 X0 = FMath::Max(0, FMath::FloorToInt32(FMath::Min3(Ax, Bx, Cx)));
				const int32 X1 = FMath::Min(CoverCells - 1, FMath::FloorToInt32(FMath::Max3(Ax, Bx, Cx)));
				const int32 Y0 = FMath::Max(0, FMath::FloorToInt32(FMath::Min3(Ay, By, Cy)));
				const int32 Y1 = FMath::Min(CoverCells - 1, FMath::FloorToInt32(FMath::Max3(Ay, By, Cy)));
				for (int32 Y = Y0; Y <= Y1; ++Y)
				{
					for (int32 X = X0; X <= X1; ++X)
					{
						const double Px = X + 0.5, Py = Y + 0.5;
						const double W0 = (Bx - Ax) * (Py - Ay) - (By - Ay) * (Px - Ax);
						const double W1 = (Cx - Bx) * (Py - By) - (Cy - By) * (Px - Bx);
						const double W2 = (Ax - Cx) * (Py - Cy) - (Ay - Cy) * (Px - Cx);
						if ((W0 >= 0 && W1 >= 0 && W2 >= 0) || (W0 <= 0 && W1 <= 0 && W2 <= 0))
						{
							Cover[Y * CoverCells + X] = Code;
						}
					}
				}
			}
		}

		// Walls tell their material where the building's ground floor is, so window rows start there
		// instead of at a multiple of the storey height above sea level (which cuts rows off on slopes).
		TArray<FVector2D> UVs;
		TArray<FVector2D> Spans;
		if (SurfaceId >= 20 && SurfaceId <= 23)
		{
			// The lowest vertex of each vertical line of the wall is the building's base (server/src/chunk.ts).
			const auto Column = [Pos](int64 i)
			{
				uint32 U, V;
				FMemory::Memcpy(&U, Pos + i * 3, sizeof(U));
				FMemory::Memcpy(&V, Pos + i * 3 + 1, sizeof(V));
				return (static_cast<uint64>(U) << 32) | V;
			};
			TMap<uint64, float> ColumnBase;
			ColumnBase.Reserve(NumVerts / 2);
			for (int64 i = 0; i < NumVerts; ++i)
			{
				float& Base = ColumnBase.FindOrAdd(Column(i), TNumericLimits<float>::Max());
				Base = FMath::Min(Base, Pos[i * 3 + 2]);
			}
			UVs.SetNumZeroed(NumVerts);
			Spans.SetNumZeroed(NumVerts);
			for (int64 i = 0; i + 2 < NumIndices; i += 3)
			{
				// A face never mixes buildings, and a gable's ridge has no wall below it, so take the lowest of the three.
				float Base = TNumericLimits<float>::Max();
				for (int64 k = 0; k < 3; ++k)
				{
					Base = FMath::Min(Base, ColumnBase.FindRef(Column(Triangles[i + k])));
				}
				// Only the position within a storey matters, which also keeps the value small and exact.
				// The server sinks walls WallSinkMeters below the lowest ground corner.
				const double RowShift = FMath::Frac((static_cast<double>(Base) + WallSinkMeters) / StoreyMeters);
				// The second number is one each building has to itself (near enough: it comes from the height
				// of its base), which the wall material uses to give houses different shutters and flowers.
				const double Own = FMath::Frac(FMath::Abs(static_cast<double>(Base)) * 7.3137 + 0.19);
				for (int64 k = 0; k < 3; ++k)
				{
					UVs[Triangles[i + k]] = FVector2D(RowShift, Own);
				}

				// Where each corner is along its wall, and how long the wall is, in metres, so the material can
				// space windows to fit the wall instead of cutting them off at its corners. The two corners
				// furthest apart on the ground are the wall's ends; the one that sorts first is its start, so
				// every triangle of a wall (and the gable above it) agrees.
				int32 Ends[2] = { Triangles[i], Triangles[i + 1] };
				double Length = -1.0;
				for (int32 a = 0; a < 3; ++a)
				{
					for (int32 b = a + 1; b < 3; ++b)
					{
						const double Apart = FVector::Dist2D(Vertices[Triangles[i + a]], Vertices[Triangles[i + b]]);
						if (Apart > Length)
						{
							Length = Apart;
							Ends[0] = Triangles[i + a];
							Ends[1] = Triangles[i + b];
						}
					}
				}
				FVector2D Start(Vertices[Ends[0]]);
				FVector2D End(Vertices[Ends[1]]);
				if (End.X < Start.X || (End.X == Start.X && End.Y < Start.Y))
				{
					Swap(Start, End);
				}
				const FVector2D Along = (End - Start).GetSafeNormal();
				for (int64 k = 0; k < 3; ++k)
				{
					const int32 Corner = Triangles[i + k];
					Spans[Corner] = FVector2D(FVector2D::DotProduct(FVector2D(Vertices[Corner]) - Start, Along) / 100.0, Length / 100.0);
				}
			}
		}
		else if (SurfaceId == 33)
		{
			// Fences tell their material how far below the top of the fence each point is, in metres, so
			// it can cut the pales to a point and leave the gaps between them (M_EarthFence). A fence is a
			// row of thin boxes (server/src/chunk.ts): on an upright face the highest corner is the top of
			// the fence; the flat face on top is marked (second number 0) to be left out.
			UVs.SetNumZeroed(NumVerts);
			for (int64 i = 0; i + 2 < NumIndices; i += 3)
			{
				double Top = Vertices[Triangles[i]].Z, Bottom = Top;
				for (int64 k = 1; k < 3; ++k)
				{
					Top = FMath::Max(Top, Vertices[Triangles[i + k]].Z);
					Bottom = FMath::Min(Bottom, Vertices[Triangles[i + k]].Z);
				}
				const bool bUpright = Top - Bottom > 1.0;
				for (int64 k = 0; k < 3; ++k)
				{
					const int32 Corner = Triangles[i + k];
					UVs[Corner] = bUpright ? FVector2D((Top - Vertices[Corner].Z) / 100.0, 1.0) : FVector2D::ZeroVector;
				}
			}
		}

		Mesh->CreateMeshSection_LinearColor(Section, Vertices, Triangles, Normals, UVs, Spans, NoUVs, NoUVs, NoColors, NoTangents, (Flags & FlagCollision) != 0);
		Mesh->SetMaterial(Section, MaterialForSurface(SurfaceId, Color));
	}

	if (!bOk)
	{
		Mesh->DestroyComponent();
		return false;
	}
	// Nothing grows hard up against a road or a wall: cells beside something in the way become its edge.
	for (int32 Y = 0; Y < CoverCells; ++Y)
	{
		for (int32 X = 0; X < CoverCells; ++X)
		{
			uint8& Cell = Cover[Y * CoverCells + X];
			if (Cell == EarthCover::Blocked || Cell == EarthCover::Edge || Cell == EarthCover::Unknown)
			{
				continue;
			}
			if ((X > 0 && Cover[Y * CoverCells + X - 1] == EarthCover::Blocked) || (X + 1 < CoverCells && Cover[Y * CoverCells + X + 1] == EarthCover::Blocked)
				|| (Y > 0 && Cover[(Y - 1) * CoverCells + X] == EarthCover::Blocked) || (Y + 1 < CoverCells && Cover[(Y + 1) * CoverCells + X] == EarthCover::Blocked))
			{
				Cell = EarthCover::Edge;
			}
		}
	}
	CoverMaps.Add(Key, MoveTemp(Cover));
	HeightMaps.Add(Key, MoveTemp(Heights));
	WaterMaps.Add(Key, MoveTemp(Water));
	Mesh->SetVisibility(!bAerial);
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
				Avatar->SetAnimal(Peer.Avatar);
			}
		}
		if (Avatar)
		{
			Avatar->SetTarget(Target, Peer.Yaw);
			Avatar->SetSeated(Peer.Ride.bOn);
			Avatar->SetHat(Peer.Hat);
		}
	}
}

/**
 * The Auto kind. On foot the player is in our own world and Google is not asked for anything. Flying
 * up, the tiles start loading out of sight, and above the switching height they take over the view;
 * coming down, our world comes back before the tiles get close enough to look rough. The player
 * collides with our world throughout: the tiles are only ever looked at.
 */
void AEarthWorld::UpdateAerial(const ACharacter* Player)
{
	if (WorldKind != EEarthWorldKind::Auto)
	{
		return;
	}
	const UEarthWalkSettings* Settings = GetDefault<UEarthWalkSettings>();
	const double Above = FMath::Max(Settings->PhotoAboveMeters, 20.0);
	const double Below = FMath::Clamp(Settings->PhotoBelowMeters, 10.0, Above - 5.0);
	const double Preload = Below * 0.5; // start fetching well before the switch, so it is ready on the way up

	const AEarthWalkCharacter* Walker = Cast<AEarthWalkCharacter>(Player);
	const bool bFlying = Walker && Walker->IsFlying() && !Walker->IsWaitingForGround();

	// Height over our own ground. The tiles have no collision in this kind, so a trace only finds our world.
	double Height = 0.0;
	if (bFlying)
	{
		const FVector Feet = Player->GetActorLocation() - FVector(0, 0, Player->GetCapsuleComponent()->GetScaledCapsuleHalfHeight());
		FHitResult Hit;
		FCollisionQueryParams Params(FName(TEXT("EarthWalkAerial")), /*bTraceComplex*/ true, Player);
		if (!GetWorld()->LineTraceSingleByChannel(Hit, Feet, Feet - FVector(0, 0, 1000000.0), ECC_Visibility, Params))
		{
			return; // nothing built below yet, so the height is unknown: leave things as they are
		}
		Height = (Feet.Z - Hit.ImpactPoint.Z) / 100.0;
	}

	// The tileset is made on the first climb, so a session that stays on foot costs no Google request.
	const bool bWanted = bFlying && Height > Preload;
	if (bWanted && !PhotoTileset)
	{
		EarthPhoto::SetOrigin(GetWorld(), OriginLat, OriginLon);
		PhotoTileset = EarthPhoto::SpawnTileset(GetWorld(), FEarthWalkConfig::MapsKey(), /*bWalkable*/ false);
		if (PhotoTileset)
		{
			PhotoTileset->SetActorHiddenInGame(true);
			bAerialSuspended = false;
			bAerialAligned = false;
			bAerialSampling = false;
			UE_LOG(LogTemp, Display, TEXT("EarthWalk: aerial view: fetching Google's tiles at %.0f m up"), Height);
		}
	}
	if (!PhotoTileset)
	{
		return;
	}

	// Back near the ground the tiles stop fetching; what is loaded stays for the next climb.
	const bool bSuspend = !bWanted && !bAerial;
	if (bSuspend != bAerialSuspended)
	{
		bAerialSuspended = bSuspend;
		EarthPhoto::SetSuspended(PhotoTileset, bSuspend);
	}
	if (!bAerialSuspended && !bAerialAligned && !bAerialSampling)
	{
		StartAerialAlignment();
	}

	const double Now = FPlatformTime::Seconds();
	if (bAerial)
	{
		if (!bFlying || Height < Below)
		{
			SetAerial(false);
		}
		return;
	}
	if (!bFlying || Height <= Above || !bAerialAligned)
	{
		AerialAboveSince = 0.0;
		return;
	}
	if (AerialAboveSince <= 0.0)
	{
		AerialAboveSince = Now;
	}
	// Switch once most of the view has loaded. Someone flying along always has new tiles on the way,
	// so that can take a while to come true; after a few seconds a view that is still sharpening beats
	// none. The first second lets the plugin count what this view needs.
	const double Waited = Now - AerialAboveSince;
	if ((Waited > 1.0 && EarthPhoto::LoadProgress(PhotoTileset) >= 80.f) || Waited > 8.0)
	{
		SetAerial(true);
	}
}

/**
 * Our heights are above sea level and the tiles' are above the ellipsoid, which are some tens of
 * metres apart, differently everywhere. So the gap is measured here: the tiles' height and ours at a
 * grid of places round the origin, and the middle one of the differences, which is not thrown by a
 * place where the tiles have a tree or a tall roof and we have not, or the other way round. (Measured
 * at Titirangi: 37 m against a true 34 m, with single places up to 15 m out either way.)
 */
void AEarthWorld::StartAerialAlignment()
{
	if (FPlatformTime::Seconds() < AerialRetryAfter)
	{
		return;
	}
	TArray<FVector2D> Places;
	TArray<double> Ours;
	for (int32 North = -2; North <= 2; ++North)
	{
		for (int32 East = -2; East <= 2; ++East)
		{
			const FVector At(North * 3000.0, East * 3000.0, 0.0);
			FHitResult Hit;
			const FCollisionQueryParams Params(FName(TEXT("EarthWalkAlign")), /*bTraceComplex*/ true);
			if (!GetWorld()->LineTraceSingleByChannel(Hit, At + FVector(0, 0, 1000000.0), At - FVector(0, 0, 100000.0), ECC_Visibility, Params)
				|| Hit.GetActor() != this)
			{
				continue; // no chunk there yet, or a tree or a person is in the way
			}
			double Lat, Lon, Alt;
			WorldToGeo(At, Lat, Lon, Alt);
			Places.Add(FVector2D(Lat, Lon));
			Ours.Add(Hit.ImpactPoint.Z / 100.0);
		}
	}
	if (Places.Num() < 5)
	{
		return; // our own world is not built here yet; this is tried again on the next pass
	}
	bAerialSampling = true;
	const int32 AskedGeneration = Generation;
	EarthPhoto::SampleHeights(PhotoTileset, Places, [WeakThis = TWeakObjectPtr<AEarthWorld>(this), AskedGeneration, Ours](const TArray<double>& Heights, const TArray<bool>& Found)
	{
		AEarthWorld* Self = WeakThis.Get();
		if (!Self || Self->Generation != AskedGeneration || Self->WorldKind != EEarthWorldKind::Auto)
		{
			return; // the player has gone somewhere else since; SetOrigin has already reset this
		}
		Self->bAerialSampling = false;
		TArray<double> Gaps;
		for (int32 i = 0; i < FMath::Min(Ours.Num(), Heights.Num()); ++i)
		{
			if (Found.IsValidIndex(i) && Found[i])
			{
				Gaps.Add(Heights[i] - Ours[i]);
			}
		}
		if (Gaps.Num() < 5)
		{
			Self->AerialRetryAfter = FPlatformTime::Seconds() + 10.0;
			return;
		}
		Gaps.Sort();
		const double Gap = Gaps[Gaps.Num() / 2];
		EarthPhoto::SetOrigin(Self->GetWorld(), Self->OriginLat, Self->OriginLon, Gap);
		Self->bAerialAligned = true;
		UE_LOG(LogTemp, Display, TEXT("EarthWalk: aerial view: the tiles are %.1f m above our heights here (%d of %d places agreed to within %.1f m)"),
			Gap, Gaps.Num(), Ours.Num(), Gaps.Last() - Gaps[0]);
	});
}

/** Shows the tiles and hides our own world, or the other way round. Our world keeps its collision either way. */
void AEarthWorld::SetAerial(bool bShowPhoto)
{
	if (bAerial == bShowPhoto)
	{
		return;
	}
	bAerial = bShowPhoto;
	AerialAboveSince = 0.0;
	for (const TPair<FIntPoint, TObjectPtr<UProceduralMeshComponent>>& Pair : Chunks)
	{
		if (Pair.Value)
		{
			Pair.Value->SetVisibility(!bAerial);
		}
	}
	for (const TPair<FIntPoint, TObjectPtr<AEarthChunkLabels>>& Pair : Labels)
	{
		if (Pair.Value)
		{
			Pair.Value->SetActorHiddenInGame(bAerial);
		}
	}
	if (PhotoTileset)
	{
		PhotoTileset->SetActorHiddenInGame(!bAerial);
	}
	if (GroundCover)
	{
		GroundCover->SetActorHiddenInGame(bAerial);
	}
	if (Life)
	{
		Life->SetActorHiddenInGame(bAerial);
	}
	// A blink of black covers the change of scenery.
	const APlayerController* Controller = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr;
	if (Controller && Controller->PlayerCameraManager)
	{
		Controller->PlayerCameraManager->StartCameraFade(1.f, 0.f, 0.35f, FLinearColor::Black, false, false);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: aerial view: %s"), bAerial ? TEXT("showing Google's tiles") : TEXT("back to our own world"));
}
