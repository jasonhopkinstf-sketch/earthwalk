#include "EarthChunkLabels.h"

#include "EarthWorld.h"
#include "Components/InstancedStaticMeshComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Components/TextRenderComponent.h"
#include "Dom/JsonObject.h"
#include "Dom/JsonValue.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	constexpr uint32 PostColor = 0x6b6b6bff;
	constexpr uint32 LetterboxColor = 0xe8e4d8ff;
	constexpr uint32 PlateColor = 0x0f4d2aff;
	// Brighter than life, to sit with the barnyard palette of the ground and houses (EarthWorld.cpp).
	constexpr uint32 BarkColor = 0x8a5a3aff;
	constexpr uint32 LeafColor = 0x4fae3cff;
	constexpr uint32 LightLeafColor = 0x7cc64aff;
	constexpr uint32 DeepLeafColor = 0x3a9446ff;
	constexpr uint32 GoldLeafColor = 0xe2b93aff;
	constexpr uint32 PinkBlossomColor = 0xf4a9c4ff;
	constexpr uint32 WhiteBlossomColor = 0xf7f0e6ff;
	constexpr uint32 AppleColor = 0xd8362eff;
	constexpr uint32 OrangeColor = 0xf08a24ff;
	constexpr uint32 NeedleColor = 0x2f8f52ff;
	constexpr uint32 DeepNeedleColor = 0x267648ff;
	// Letterboxes are about three times life size, so the number reads from across the street.
	constexpr double LetterboxPostHeight = 150.0; // cm
	const FVector LetterboxSize(54.0, 90.0, 66.0); // depth (towards the street), width, height in cm
	constexpr float NumberSize = 46.f; // text height in cm
	constexpr float NameSize = 16.f;
}

AEarthChunkLabels::AEarthChunkLabels()
{
	PrimaryActorTick.bCanEverTick = false;
	RootComponent = CreateDefaultSubobject<USceneComponent>(TEXT("Root"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cone(TEXT("/Engine/BasicShapes/Cone.Cone"));
	CubeMesh = Cube.Object;
	CylinderMesh = Cylinder.Object;
	SphereMesh = Sphere.Object;
	ConeMesh = Cone.Object;
}

void AEarthChunkLabels::AddBox(const FVector& Location, const FRotator& Rotation, const FVector& SizeCm, UMaterialInterface* Material)
{
	UStaticMeshComponent* Box = NewObject<UStaticMeshComponent>(this);
	Box->SetStaticMesh(CubeMesh);
	if (Material)
	{
		Box->SetMaterial(0, Material);
	}
	Box->SetMobility(EComponentMobility::Movable);
	Box->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Box->SetupAttachment(RootComponent);
	Box->SetRelativeLocation(Location);
	Box->SetRelativeRotation(Rotation);
	Box->SetRelativeScale3D(SizeCm / 100.0); // the engine cube is 100 cm across
	Box->RegisterComponent();
}

void AEarthChunkLabels::AddText(const FString& Text, const FVector& Location, const FRotator& Rotation, float SizeCm, const FColor& Color)
{
	// Text render components read correctly from their +X side and use the engine's Roboto font by default.
	UTextRenderComponent* Label = NewObject<UTextRenderComponent>(this);
	Label->SetMobility(EComponentMobility::Movable);
	Label->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Label->SetupAttachment(RootComponent);
	Label->SetRelativeLocation(Location);
	Label->SetRelativeRotation(Rotation);
	Label->SetText(FText::FromString(Text));
	Label->SetWorldSize(SizeCm);
	Label->SetHorizontalAlignment(EHTA_Center);
	Label->SetVerticalAlignment(EVRTA_TextCenter);
	Label->SetTextRenderColor(Color);
	Label->RegisterComponent();
}

void AEarthChunkLabels::AddPlate(const FString& Text, const FVector& Location, double Yaw, AEarthWorld* World)
{
	const FRotator Facing(0.0, Yaw, 0.0);
	const FRotator Back(0.0, Yaw + 180.0, 0.0);
	const double Width = FMath::Clamp(Text.Len() * NameSize * 0.62 + 24.0, 60.0, 420.0);
	AddBox(Location, Facing, FVector(3.0, Width, 22.0), World->MaterialFor(PlateColor));
	AddText(Text, Location + Facing.RotateVector(FVector(2.0, 0, 0)), Facing, NameSize, FColor::White);
	AddText(Text, Location + Facing.RotateVector(FVector(-2.0, 0, 0)), Back, NameSize, FColor::White);
}

UInstancedStaticMeshComponent* AEarthChunkLabels::Instanced(TObjectPtr<UInstancedStaticMeshComponent>& Slot, UStaticMesh* Mesh, UMaterialInterface* Material, bool bCollide)
{
	if (!Slot)
	{
		UInstancedStaticMeshComponent* Component = NewObject<UInstancedStaticMeshComponent>(this);
		Component->SetStaticMesh(Mesh);
		if (Material)
		{
			Component->SetMaterial(0, Material);
		}
		Component->SetMobility(EComponentMobility::Movable);
		if (bCollide)
		{
			Component->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
			Component->SetCollisionObjectType(ECC_WorldStatic);
			Component->SetCollisionResponseToAllChannels(ECR_Block);
		}
		else
		{
			Component->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		}
		Component->SetupAttachment(RootComponent);
		Component->RegisterComponent();
		Slot = Component;
	}
	return Slot;
}

UInstancedStaticMeshComponent* AEarthChunkLabels::Blobs(uint32 Color, AEarthWorld* World)
{
	return Instanced(BlobParts.FindOrAdd(Color), SphereMesh, World->MaterialForFoliage(Color, 1.f, 6), false);
}

UInstancedStaticMeshComponent* AEarthChunkLabels::Cones(uint32 Color, AEarthWorld* World)
{
	return Instanced(ConeParts.FindOrAdd(Color), ConeMesh, World->MaterialForFoliage(Color, 1.f, 4), false);
}

/**
 * A tree from engine shapes, in metres. The server says where it stands, how tall and wide it is and
 * whether it is a conifer; which kind of tree it is comes from Seed, a number of the tree's own.
 * Broadleaves: a round crown of several blobs (some light green, a few gold), a tall narrow one, a
 * wide spreading one, one in blossom, one hung with fruit. Conifers: tiered, slim, or a plain cone.
 */
void AEarthChunkLabels::AddTree(const FVector& Base, double Yaw, double HeightM, double RadiusM, bool bConifer, uint32 Seed, AEarthWorld* World)
{
	const FRotator Spin(0.0, Yaw, 0.0);
	const int32 Pick = Seed % 100;
	const double H = HeightM * 100.0; // cm
	const double R = RadiusM * 100.0;
	// The engine sphere and cone are 100 cm across, so a scale is a size in metres.
	const auto Blob = [&](UInstancedStaticMeshComponent* Part, const FVector& Offset, const FVector& SizeM)
	{
		Part->AddInstance(FTransform(Spin, Base + Spin.RotateVector(Offset), SizeM), true);
	};
	const auto Trunk = [&](double Tall, double Thick)
	{
		Instanced(Trunks, CylinderMesh, World->MaterialForFoliage(BarkColor, 0.f), true)
			->AddInstance(FTransform(Spin, Base + FVector(0, 0, Tall * 50.0), FVector(Thick, Thick, Tall)), true);
	};

	if (bConifer)
	{
		if (Pick < 60)
		{
			// Tiered: three skirts, each smaller and higher.
			UInstancedStaticMeshComponent* Part = Cones((Seed >> 8) % 3 == 0 ? DeepNeedleColor : NeedleColor, World);
			Trunk(HeightM * 0.3, 0.3);
			Blob(Part, FVector(0, 0, H * 0.42), FVector(RadiusM * 2.0, RadiusM * 2.0, HeightM * 0.5));
			Blob(Part, FVector(0, 0, H * 0.62), FVector(RadiusM * 1.55, RadiusM * 1.55, HeightM * 0.42));
			Blob(Part, FVector(0, 0, H * 0.82), FVector(RadiusM * 1.05, RadiusM * 1.05, HeightM * 0.36));
		}
		else if (Pick < 85)
		{
			// Slim and dark, like a cypress.
			Trunk(HeightM * 0.2, 0.25);
			Blob(Cones(DeepNeedleColor, World), FVector(0, 0, H * 0.56), FVector(RadiusM * 1.1, RadiusM * 1.1, HeightM * 0.9));
		}
		else
		{
			Trunk(HeightM * 0.3, 0.3);
			Blob(Cones(NeedleColor, World), FVector(0, 0, H * 0.6), FVector(RadiusM * 1.8, RadiusM * 1.8, HeightM * 0.8));
		}
		++Trees;
		return;
	}

	// A round crown: a big blob with a ring of five round it, alternately high and low, and one on top.
	const auto RoundCrown = [&](UInstancedStaticMeshComponent* Part, double Size)
	{
		const FVector Centre(0, 0, H * 0.68);
		Blob(Part, Centre, FVector(RadiusM * 2.0, RadiusM * 2.0, RadiusM * 1.7) * Size);
		for (int32 i = 0; i < 5; ++i)
		{
			const double Angle = (i * 72.0 + (Seed >> 4) % 72) * UE_PI / 180.0;
			const double Lift = (i % 2 ? 0.28 : -0.2) * R;
			const double Big = 1.15 + 0.07 * ((Seed >> (i * 3)) % 5);
			Blob(Part, Centre + FVector(FMath::Cos(Angle) * R * 0.6, FMath::Sin(Angle) * R * 0.6, Lift) * Size, FVector(RadiusM * Big) * Size);
		}
		Blob(Part, Centre + FVector(0, 0, R * 0.6 * Size), FVector(RadiusM * 1.3) * Size);
	};

	if (Pick < 40)
	{
		Trunk(HeightM * 0.45, 0.32);
		RoundCrown(Blobs((Seed >> 8) % 3 == 0 ? LightLeafColor : LeafColor, World), 1.0);
	}
	else if (Pick < 58)
	{
		// Tall and narrow: three long blobs stacked, each slimmer than the one below.
		UInstancedStaticMeshComponent* Part = Blobs(DeepLeafColor, World);
		Trunk(HeightM * 0.32, 0.26);
		Blob(Part, FVector(0, 0, H * 0.45), FVector(RadiusM * 1.5, RadiusM * 1.5, HeightM * 0.42));
		Blob(Part, FVector(0, 0, H * 0.68), FVector(RadiusM * 1.25, RadiusM * 1.25, HeightM * 0.42));
		Blob(Part, FVector(0, 0, H * 0.88), FVector(RadiusM * 0.85, RadiusM * 0.85, HeightM * 0.36));
	}
	else if (Pick < 75)
	{
		// Wide and spreading: a low dome with six flattened blobs round its rim, on a stout trunk.
		UInstancedStaticMeshComponent* Part = Blobs(LeafColor, World);
		Trunk(HeightM * 0.4, 0.42);
		const FVector Centre(0, 0, H * 0.6);
		Blob(Part, Centre, FVector(RadiusM * 2.3, RadiusM * 2.3, RadiusM * 1.3));
		for (int32 i = 0; i < 6; ++i)
		{
			const double Angle = (i * 60.0 + (Seed >> 4) % 60) * UE_PI / 180.0;
			Blob(Part, Centre + FVector(FMath::Cos(Angle) * R * 0.95, FMath::Sin(Angle) * R * 0.95, (i % 2 ? 0.12 : -0.1) * R), FVector(RadiusM * 1.5, RadiusM * 1.5, RadiusM * 1.0));
		}
	}
	else if (Pick < 85)
	{
		// In blossom.
		Trunk(HeightM * 0.42, 0.28);
		RoundCrown(Blobs((Seed >> 8) % 2 ? PinkBlossomColor : WhiteBlossomColor, World), 0.9);
	}
	else if (Pick < 95)
	{
		// Hung with fruit: apples or oranges dotted over the lower half of the crown.
		Trunk(HeightM * 0.42, 0.3);
		RoundCrown(Blobs(LeafColor, World), 0.9);
		UInstancedStaticMeshComponent* Fruit = Instanced(BlobParts.FindOrAdd((Seed >> 8) % 2 ? AppleColor : OrangeColor), SphereMesh,
			World->MaterialForFoliage((Seed >> 8) % 2 ? AppleColor : OrangeColor, 0.f, 6), false);
		for (int32 i = 0; i < 9; ++i)
		{
			const double Angle = (i * 40.0 + (Seed >> 5) % 40) * UE_PI / 180.0;
			const double Out = R * (0.78 + 0.16 * (i % 3));
			Blob(Fruit, FVector(FMath::Cos(Angle) * Out, FMath::Sin(Angle) * Out, H * 0.68 + R * (0.3 - 0.22 * (i % 4))) * FVector(0.9, 0.9, 1.0), FVector(0.3));
		}
	}
	else
	{
		// Turning gold.
		Trunk(HeightM * 0.45, 0.32);
		RoundCrown(Blobs(GoldLeafColor, World), 1.0);
	}
	++Trees;
}

void AEarthChunkLabels::Build(const TArray<TSharedPtr<FJsonValue>>& Items, const FVector& ChunkOrigin, double TileCm, AEarthWorld* World)
{
	// First, what the doors of shops and offices need to know of each other and of the name boards:
	// a building's name is on one of its doors only, and a door under a board with the same name gets no second one.
	TMap<int64, FString> Names;
	struct FBoard { FString Text; FVector At; double Yaw; };
	TArray<FBoard> Boards;
	for (const TSharedPtr<FJsonValue>& Value : Items)
	{
		const TSharedPtr<FJsonObject>* Item = nullptr;
		FString Kind, Text;
		double U = 0.0, V = 0.0, H = 0.0, Yaw = 0.0, Id = 0.0;
		if (!Value.IsValid() || !Value->TryGetObject(Item) || !(*Item)->TryGetStringField(TEXT("kind"), Kind) || !(*Item)->TryGetStringField(TEXT("text"), Text) || Text.IsEmpty())
		{
			continue;
		}
		if ((Kind == TEXT("entry") || Kind == TEXT("door")) && (*Item)->TryGetNumberField(TEXT("id"), Id))
		{
			Names.Add(static_cast<int64>(Id), Text);
		}
		else if (Kind == TEXT("sign") && (*Item)->TryGetNumberField(TEXT("u"), U) && (*Item)->TryGetNumberField(TEXT("v"), V) && (*Item)->TryGetNumberField(TEXT("h"), H))
		{
			(*Item)->TryGetNumberField(TEXT("yaw"), Yaw);
			Boards.Add({ Text, ChunkOrigin + FVector(-V * TileCm, U * TileCm, H * 100.0), Yaw });
		}
	}
	for (const TSharedPtr<FJsonValue>& Value : Items)
	{
		const TSharedPtr<FJsonObject>* Item = nullptr;
		if (!Value.IsValid() || !Value->TryGetObject(Item) || !Item || !Item->IsValid())
		{
			continue;
		}
		const FJsonObject& Json = **Item;
		FString Kind;
		double U = 0.0, V = 0.0, H = 0.0, Yaw = 0.0;
		if (!Json.TryGetStringField(TEXT("kind"), Kind) ||
			!Json.TryGetNumberField(TEXT("u"), U) || !Json.TryGetNumberField(TEXT("v"), V) || !Json.TryGetNumberField(TEXT("h"), H))
		{
			continue;
		}
		Json.TryGetNumberField(TEXT("yaw"), Yaw);
		// u grows east (+Y), v grows south (-X); yaw is a compass heading, which is also the engine's yaw.
		const FVector At = ChunkOrigin + FVector(-V * TileCm, U * TileCm, H * 100.0);
		const FRotator Facing(0.0, Yaw, 0.0);

		if (Kind == TEXT("tree"))
		{
			double HeightM = 7.0, RadiusM = 2.0, Conifer = 0.0;
			Json.TryGetNumberField(TEXT("s"), HeightM);
			Json.TryGetNumberField(TEXT("r"), RadiusM);
			Json.TryGetNumberField(TEXT("c"), Conifer);
			// The tree's own number comes from where it stands in its chunk, so it is the same tree every visit.
			const uint32 Seed = HashCombine(GetTypeHash(FMath::RoundToInt32(U * 1000000.0)), GetTypeHash(FMath::RoundToInt32(V * 1000000.0)));
			AddTree(At, Yaw, FMath::Clamp(HeightM, 2.0, 40.0), FMath::Clamp(RadiusM, 0.5, 12.0), Conifer > 0.5, Seed, World);
			continue;
		}

		FString Use;
		Json.TryGetStringField(TEXT("use"), Use);
		if (Kind == TEXT("entry") || (Kind == TEXT("door") && !Use.IsEmpty()))
		{
			// A door of a shop, a café, an office, a mall, a block of flats or a hotel (docs/PROTOCOL.md, "Inside
			// other buildings"). An "entry" is drawn here, since the server's mesh has no door at that spot (unless
			// "drawn" says it has): glass double doors in a white frame, with a mat. Over every such door goes a
			// cream board with the building's name, or with what it is. At is the door on its wall at the height of
			// the floor inside; "g" is the ground outside it, which the doors and the board stand on.
			double Ground = H, Porch = 0.0, Drawn = 0.0, Id = 0.0;
			Json.TryGetNumberField(TEXT("g"), Ground);
			Json.TryGetNumberField(TEXT("porch"), Porch);
			Json.TryGetNumberField(TEXT("drawn"), Drawn);
			Json.TryGetNumberField(TEXT("id"), Id);
			const bool bGlass = Kind == TEXT("entry") && Drawn < 0.5;
			const FVector Doorstep(At.X, At.Y, ChunkOrigin.Z + Ground * 100.0);
			const auto Out = [&](double OutCm, double AcrossCm, double UpCm) { return Doorstep + Facing.RotateVector(FVector(OutCm, AcrossCm, UpCm)); };
			if (bGlass)
			{
				UMaterialInterface* White = World->MaterialFor(0xf7f7f4ff);
				AddBox(Out(2.0, 0.0, 95.0), Facing, FVector(16.0, 190.0, 270.0), White); // the frame; it goes 40 cm into the ground, for a sloping street
				for (const double Side : { -43.0, 43.0 })
				{
					AddBox(Out(9.0, Side, 110.0), Facing, FVector(5.0, 80.0, 212.0), World->MaterialFor(0xa9d6f2ff)); // a leaf of pale blue glass
					AddBox(Out(13.0, Side, 105.0), Facing, FVector(3.0, 62.0, 7.0), White); // and the bar across it
				}
				AddBox(Out(60.0, 0.0, 2.5), Facing, FVector(90.0, 170.0, 5.0), World->MaterialFor(0x3a3a40ff)); // the mat
			}
			FString Words;
			if (!Json.TryGetStringField(TEXT("text"), Words) || Words.IsEmpty())
			{
				Words = Names.FindRef(static_cast<int64>(Id));
			}
			if (Words.IsEmpty())
			{
				Words = FEarthDoor::UseWords(Use, 0);
				if (Words.IsEmpty())
				{
					Words = TEXT("COME IN");
				}
			}
			// Glass doors carry their board just above the frame; a door the mesh drew has it where COME IN would be.
			const FVector Board = bGlass ? Out(13.0, 0.0, 262.0) : Porch > 0.5 ? Out(103.0, 0.0, 276.0 + 30.0) : Out(11.0, 0.0, 281.0);
			bool bNamedAlready = false;
			for (const FBoard& Other : Boards)
			{
				const double Turn = FMath::Abs(FMath::FindDeltaAngleDegrees(Other.Yaw, Yaw));
				bNamedAlready = bNamedAlready || (Other.Text == Words && FVector::Dist(Other.At, Board) < 450.0 && Turn < 30.0);
			}
			if (!bNamedAlready)
			{
				const double Width = FMath::Clamp(Words.Len() * 20.0 + 50.0, 130.0, 340.0);
				AddBox(Board, Facing, FVector(6.0, Width, 56.0), World->MaterialFor(0xf4f1e6ff));
				const float Size = FMath::Min(34.f, static_cast<float>(Width * 0.92 / (FMath::Max(Words.Len(), 1) * 0.62)));
				AddText(Words, Board + Facing.RotateVector(FVector(3.8, 0.0, 0.0)), Facing, Size, FColor(38, 34, 31));
			}
			++Count;
			continue;
		}
		if (Kind == TEXT("door"))
		{
			// A front door that opens (AEarthWorld keeps where it is). It gets a yellow board over it that says
			// so, to be seen from the street. At is the door on its wall at the height of the floor inside,
			// which on a hillside can be metres above the door itself: `g` is the ground outside the door,
			// and the board hangs from there. Where a porch roof covers the door (it reaches a metre out, its
			// top 2.76 m up) the board stands on the front of that. Facing is the way out.
			double Ground = H, Porch = 0.0;
			Json.TryGetNumberField(TEXT("g"), Ground);
			Json.TryGetNumberField(TEXT("porch"), Porch);
			const FVector Doorstep(At.X, At.Y, ChunkOrigin.Z + Ground * 100.0);
			const FVector Board = Doorstep + Facing.RotateVector(Porch > 0.5 ? FVector(103.0, 0.0, 276.0 + 22.0) : FVector(14.0, 0.0, 292.0));
			AddBox(Board, Facing, FVector(6.0, 96.0, 32.0), World->MaterialFor(0xf5c518ff));
			AddText(TEXT("COME IN"), Board + Facing.RotateVector(FVector(3.8, 0.0, 0.0)), Facing, 17.f, FColor(38, 34, 31));
			++Count;
			continue;
		}
		if (Kind == TEXT("home") || Kind == TEXT("car") || Kind == TEXT("route") || Kind == TEXT("train"))
		{
			continue; // the living world: AEarthLife takes these from the same reply
		}

		FString Text;
		if (!Json.TryGetStringField(TEXT("text"), Text))
		{
			continue;
		}
		if (Kind == TEXT("house"))
		{
			const FVector BoxAt = At + FVector(0, 0, LetterboxPostHeight + LetterboxSize.Z * 0.5);
			AddBox(At + FVector(0, 0, LetterboxPostHeight * 0.5), Facing, FVector(14, 14, LetterboxPostHeight), World->MaterialFor(PostColor));
			AddBox(BoxAt, Facing, LetterboxSize, World->MaterialFor(LetterboxColor));
			// Long numbers ("12A", "3/41") shrink to stay on the box. The number is on the street side and on the back.
			const float Size = FMath::Min(NumberSize, static_cast<float>(LetterboxSize.Y * 0.9 / (FMath::Max(Text.Len(), 1) * 0.62)));
			const double Out = LetterboxSize.X * 0.5 + 0.8;
			AddText(Text, BoxAt + Facing.RotateVector(FVector(Out, 0, 0)), Facing, Size, FColor(15, 15, 15));
			AddText(Text, BoxAt + Facing.RotateVector(FVector(-Out, 0, 0)), FRotator(0.0, Yaw + 180.0, 0.0), Size, FColor(15, 15, 15));
		}
		else if (Kind == TEXT("sign"))
		{
			// What a building is called, on a cream board on its front wall. At is the middle of the board,
			// Facing the way it faces, and w how wide it may be; the lettering shrinks to fit a long name.
			double WidthM = 2.0;
			Json.TryGetNumberField(TEXT("w"), WidthM);
			const double Width = FMath::Clamp(WidthM, 1.0, 10.0) * 100.0;
			AddBox(At, Facing, FVector(6.0, Width, 56.0), World->MaterialFor(0xf4f1e6ff));
			const float Size = FMath::Min(34.f, static_cast<float>(Width * 0.92 / (FMath::Max(Text.Len(), 1) * 0.62)));
			AddText(Text, At + Facing.RotateVector(FVector(3.8, 0.0, 0.0)), Facing, Size, FColor(38, 34, 31));
		}
		else if (Kind == TEXT("street"))
		{
			AddBox(At + FVector(0, 0, 130), FRotator::ZeroRotator, FVector(8, 8, 260), World->MaterialFor(PostColor));
			AddPlate(Text, At + FVector(0, 0, 240), Yaw, World);
			FString Text2;
			if (Json.TryGetStringField(TEXT("text2"), Text2) && !Text2.IsEmpty())
			{
				double Yaw2 = Yaw;
				Json.TryGetNumberField(TEXT("yaw2"), Yaw2);
				AddPlate(Text2, At + FVector(0, 0, 215), Yaw2, World);
			}
		}
		else
		{
			continue;
		}
		++Count;
	}
}
