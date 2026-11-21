#include "EarthWorld.h"

#include "EarthChunkLabels.h"
#include "EarthGeo.h"
#include "EarthPhotoWorld.h"
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
	// With the plugin and a key, the view from the air is photographic unless told otherwise.
	// -EWWorld=auto|photo|generated chooses for this run.
	EEarthWorldKind Wanted = EarthPhoto::IsBuiltIn() && !FEarthWalkConfig::MapsKey().IsEmpty() ? EEarthWorldKind::Auto : EEarthWorldKind::Generated;
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

namespace
{
	/** How each server surface id is drawn: which master material, which texture, and how strongly the server's colour tints it. */
	struct FSurfaceStyle
	{
		const TCHAR* Master; // asset name under /Game/EarthWalk/Materials
		const TCHAR* Texture; // name under /Game/EarthWalk/Textures (T_<name>_D and _N), or null
		float RepeatMeters;
		float TintAmount; // 0 = texture's own colour, 1 = fully tinted by the server's colour
		float Roughness;
		float Windows;
	};

	const FSurfaceStyle* StyleFor(uint32 SurfaceId)
	{
		static const TMap<uint32, FSurfaceStyle> Styles = {
			// Ground cover (server/src/chunk.ts MATERIALS)
			{ 0, { TEXT("M_EarthTop"), TEXT("grass"), 4.f, 0.7f, 0.9f, 0.f } }, // unclassified land: rough grass
			{ 1, { TEXT("M_EarthTop"), TEXT("grass"), 4.f, 0.75f, 0.9f, 0.f } },
			{ 2, { TEXT("M_EarthTop"), TEXT("forest"), 4.f, 0.4f, 0.95f, 0.f } },
			{ 3, { TEXT("M_EarthTop"), TEXT("soil"), 5.f, 0.4f, 0.9f, 0.f } },
			{ 4, { TEXT("M_EarthTop"), TEXT("sand"), 4.f, 0.4f, 0.8f, 0.f } },
			{ 5, { TEXT("M_EarthTop"), TEXT("grass"), 4.f, 0.5f, 0.9f, 0.f } }, // residential land: lawns
			{ 6, { TEXT("M_EarthTop"), TEXT("paving"), 2.f, 0.5f, 0.7f, 0.f } },
			{ 7, { TEXT("M_EarthWater"), nullptr, 0.f, 1.f, 0.f, 0.f } },
			{ 8, { TEXT("M_EarthTop"), TEXT("rock"), 5.f, 0.4f, 0.9f, 0.f } },
			// Roads
			{ 10, { TEXT("M_EarthTop"), TEXT("asphalt"), 3.f, 0.3f, 0.85f, 0.f } },
			{ 11, { TEXT("M_EarthTop"), TEXT("gravel"), 2.f, 0.6f, 0.9f, 0.f } },
			{ 12, { TEXT("M_EarthTop"), TEXT("gravel"), 2.f, 0.7f, 0.9f, 0.f } },
			{ 13, { TEXT("M_EarthWater"), nullptr, 0.f, 1.f, 0.f, 0.f } },
			// Building walls, with windows
			{ 20, { TEXT("M_EarthWall"), TEXT("plaster"), 3.f, 0.8f, 0.85f, 1.f } },
			{ 21, { TEXT("M_EarthWall"), TEXT("brick"), 2.5f, 0.25f, 0.8f, 1.f } },
			{ 22, { TEXT("M_EarthWall"), TEXT("concrete"), 3.f, 0.6f, 0.75f, 1.f } },
			{ 23, { TEXT("M_EarthWall"), TEXT("brick"), 2.5f, 0.45f, 0.8f, 1.f } },
			// Roofs
			{ 24, { TEXT("M_EarthTop"), TEXT("roof_grey"), 2.f, 0.5f, 0.7f, 0.f } },
			{ 25, { TEXT("M_EarthTop"), TEXT("roof_clay"), 2.f, 0.3f, 0.75f, 0.f } },
		};
		return Styles.Find(SurfaceId);
	}

	template <class T>
	T* LoadArt(const TCHAR* Folder, const FString& Name)
	{
		return LoadObject<T>(nullptr, *FString::Printf(TEXT("/Game/EarthWalk/%s/%s.%s"), Folder, *Name, *Name));
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
		const FColor Color((Rgba >> 24) & 0xff, (Rgba >> 16) & 0xff, (Rgba >> 8) & 0xff, 255);
		Material->SetVectorParameterValue(TEXT("Color"), FLinearColor::FromSRGBColor(Color));
		if (Style->Texture)
		{
			if (UTexture* Albedo = LoadArt<UTexture>(TEXT("Textures"), FString::Printf(TEXT("T_%s_D"), Style->Texture)))
			{
				Material->SetTextureParameterValue(TEXT("Albedo"), Albedo);
			}
			if (UTexture* Normal = LoadArt<UTexture>(TEXT("Textures"), FString::Printf(TEXT("T_%s_N"), Style->Texture)))
			{
				Material->SetTextureParameterValue(TEXT("NormalMap"), Normal);
			}
			Material->SetScalarParameterValue(TEXT("Repeat"), Style->RepeatMeters);
			Material->SetScalarParameterValue(TEXT("TintAmount"), Style->TintAmount);
			Material->SetScalarParameterValue(TEXT("Roughness"), Style->Roughness);
			Material->SetScalarParameterValue(TEXT("Windows"), Style->Windows);
		}
	}
	SurfaceMaterials.Add(Key, Material);
	return Material;
}

UMaterialInstanceDynamic* AEarthWorld::MaterialForFoliage(uint32 Rgba, float Fluff)
{
	const uint64 Key = (static_cast<uint64>(Fluff > 0.5f ? 101 : 100) << 32) | Rgba;
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

		// Walls tell their material where the building's ground floor is, so window rows start there
		// instead of at a multiple of the storey height above sea level (which cuts rows off on slopes).
		TArray<FVector2D> UVs;
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
				for (int64 k = 0; k < 3; ++k)
				{
					UVs[Triangles[i + k]] = FVector2D(RowShift, 0.0);
				}
			}
		}

		Mesh->CreateMeshSection_LinearColor(Section, Vertices, Triangles, Normals, UVs, NoColors, NoTangents, (Flags & FlagCollision) != 0);
		Mesh->SetMaterial(Section, MaterialForSurface(SurfaceId, Color));
	}

	if (!bOk)
	{
		Mesh->DestroyComponent();
		return false;
	}
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
	// A blink of black covers the change of scenery.
	const APlayerController* Controller = GetWorld() ? GetWorld()->GetFirstPlayerController() : nullptr;
	if (Controller && Controller->PlayerCameraManager)
	{
		Controller->PlayerCameraManager->StartCameraFade(1.f, 0.f, 0.35f, FLinearColor::Black, false, false);
	}
	UE_LOG(LogTemp, Display, TEXT("EarthWalk: aerial view: %s"), bAerial ? TEXT("showing Google's tiles") : TEXT("back to our own world"));
}
