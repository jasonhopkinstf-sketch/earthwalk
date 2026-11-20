#include "EarthAnimalFigure.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"

UEarthAnimalFigure::UEarthAnimalFigure()
{
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Sphere(TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cone(TEXT("/Engine/BasicShapes/Cone.Cone"));
	static ConstructorHelpers::FObjectFinder<UMaterialInterface> Material(TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	SphereMesh = Sphere.Object;
	ConeMesh = Cone.Object;
	BaseMaterial = Material.Object;
}

const UEarthAnimalFigure::FAnimalSpec& UEarthAnimalFigure::SpecFor(const FString& Id)
{
	// Same table as ANIMALS in server/public/js/avatars.js.
	static const FAnimalSpec Animals[] = {
		{ TEXT("fox"), 0xd9682b, 0xf4ede2, EEars::Pointed, ETail::Bushy },
		{ TEXT("bear"), 0x7a5234, 0xb08a63, EEars::Round, ETail::Stub },
		{ TEXT("rabbit"), 0xe6e0d6, 0xffffff, EEars::Long, ETail::Stub },
		{ TEXT("cat"), 0x5d6270, 0xc9ccd4, EEars::Pointed, ETail::Thin },
		{ TEXT("owl"), 0x8a6b4a, 0xd9c7a8, EEars::Tuft, ETail::None },
		{ TEXT("frog"), 0x5fae4e, 0xd8e8a8, EEars::None, ETail::None },
	};
	for (const FAnimalSpec& Spec : Animals)
	{
		if (Id.Equals(Spec.Id, ESearchCase::IgnoreCase))
		{
			return Spec;
		}
	}
	return Animals[0];
}

UMaterialInstanceDynamic* UEarthAnimalFigure::Tint(uint32 Hex)
{
	UMaterialInstanceDynamic* Material = UMaterialInstanceDynamic::Create(BaseMaterial, this);
	if (Material)
	{
		const FColor Color((Hex >> 16) & 0xff, (Hex >> 8) & 0xff, Hex & 0xff, 255);
		Material->SetVectorParameterValue(TEXT("Color"), FLinearColor::FromSRGBColor(Color));
		Tints.Add(Material);
	}
	return Material;
}

void UEarthAnimalFigure::AddPart(bool bCone, UMaterialInstanceDynamic* Material, const FVector& Scale, const FVector& Position, double RotX)
{
	UObject* Outer = GetOwner() ? static_cast<UObject*>(GetOwner()) : static_cast<UObject*>(this);
	UStaticMeshComponent* Part = NewObject<UStaticMeshComponent>(Outer);
	Part->SetStaticMesh(bCone ? ConeMesh : SphereMesh);
	if (Material)
	{
		Part->SetMaterial(0, Material);
	}
	Part->SetMobility(EComponentMobility::Movable);
	Part->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Part->SetupAttachment(this);
	// Browser figure: x east, y up, z south, unit radius. Engine: X north, Y east, Z up, 100 cm shapes.
	Part->SetRelativeLocation(FVector(-Position.Z, Position.X, Position.Y) * 100.0);
	Part->SetRelativeRotation(FRotator(FMath::RadiansToDegrees(RotX), 0.0, 0.0));
	Part->SetRelativeScale3D(bCone
		? FVector(2.0 * Scale.Z, 2.0 * Scale.X, Scale.Y)
		: FVector(2.0 * Scale.Z, 2.0 * Scale.X, 2.0 * Scale.Y));
	Part->SetVisibility(IsVisible());
	Part->RegisterComponent();
	Parts.Add(Part);
}

void UEarthAnimalFigure::SetAnimal(const FString& Id)
{
	const FAnimalSpec& A = SpecFor(Id);
	if (AnimalId == A.Id && Parts.Num() > 0)
	{
		return;
	}
	AnimalId = A.Id;
	for (UStaticMeshComponent* Part : Parts)
	{
		if (Part)
		{
			Part->DestroyComponent();
		}
	}
	Parts.Reset();
	Tints.Reset();

	UMaterialInstanceDynamic* Body = Tint(A.Body);
	UMaterialInstanceDynamic* Belly = Tint(A.Belly);
	UMaterialInstanceDynamic* Dark = Tint(0x1c1c1c);

	AddPart(false, Body, FVector(0.32, 0.4, 0.3), FVector(0, 0.55, 0));
	AddPart(false, Belly, FVector(0.24, 0.3, 0.2), FVector(0, 0.52, -0.14));
	AddPart(false, Body, FVector(0.27, 0.25, 0.26), FVector(0, 1.1, 0)); // head
	if (AnimalId == TEXT("owl"))
	{
		AddPart(true, Tint(0xe0a030), FVector(0.05, 0.12, 0.05), FVector(0, 1.06, -0.28), -UE_DOUBLE_PI / 2.0); // beak
	}
	else
	{
		AddPart(false, Belly, FVector(0.13, 0.1, 0.12), FVector(0, 1.04, -0.22)); // muzzle
		AddPart(false, Dark, FVector(0.04, 0.035, 0.03), FVector(0, 1.08, -0.34)); // nose
	}
	const bool bFrog = AnimalId == TEXT("frog");
	for (const double Side : { -1.0, 1.0 })
	{
		if (bFrog)
		{
			AddPart(false, Belly, FVector(0.09), FVector(Side * 0.14, 1.32, -0.08)); // bulging eye
			AddPart(false, Dark, FVector(0.04, 0.05, 0.03), FVector(Side * 0.14, 1.33, -0.16));
		}
		else
		{
			AddPart(false, Dark, FVector(0.04, 0.05, 0.03), FVector(Side * 0.11, 1.16, -0.22)); // eye
		}
		AddPart(false, Body, FVector(0.12, 0.1, 0.17), FVector(Side * 0.15, 0.1, -0.03)); // foot
		AddPart(false, Body, FVector(0.09, 0.2, 0.1), FVector(Side * 0.34, 0.62, -0.02)); // arm
		switch (A.Ears)
		{
		case EEars::Pointed: AddPart(true, Body, FVector(0.09, 0.2, 0.06), FVector(Side * 0.16, 1.4, 0)); break;
		case EEars::Round: AddPart(false, Body, FVector(0.1, 0.1, 0.05), FVector(Side * 0.2, 1.32, 0)); break;
		case EEars::Long: AddPart(false, Body, FVector(0.06, 0.26, 0.04), FVector(Side * 0.1, 1.52, 0.02)); break;
		case EEars::Tuft: AddPart(true, Body, FVector(0.05, 0.14, 0.05), FVector(Side * 0.18, 1.36, -0.04)); break;
		default: break;
		}
	}
	switch (A.Tail)
	{
	case ETail::Bushy:
		AddPart(false, Body, FVector(0.12, 0.12, 0.3), FVector(0, 0.42, 0.42), -0.6);
		AddPart(false, Belly, FVector(0.09, 0.09, 0.1), FVector(0, 0.56, 0.62));
		break;
	case ETail::Stub: AddPart(false, Belly, FVector(0.09), FVector(0, 0.36, 0.3)); break;
	case ETail::Thin: AddPart(false, Body, FVector(0.04, 0.04, 0.34), FVector(0, 0.5, 0.42), -0.9); break;
	default: break;
	}
}
