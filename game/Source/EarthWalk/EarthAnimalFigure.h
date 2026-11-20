#pragma once

#include "CoreMinimal.h"
#include "Components/SceneComponent.h"
#include "EarthAnimalFigure.generated.h"

class UMaterialInstanceDynamic;
class UMaterialInterface;
class UStaticMesh;
class UStaticMeshComponent;

/**
 * One of the six animals, built from engine spheres and cones. The sizes mirror makeAnimal()
 * in server/public/js/avatars.js, so browser and Unreal players see the same figures.
 * About 1.4 m tall before scaling, feet at the component origin, facing +X.
 */
UCLASS()
class UEarthAnimalFigure : public USceneComponent
{
	GENERATED_BODY()

public:
	UEarthAnimalFigure();

	/** Rebuilds the figure as the given animal: fox, bear, rabbit, cat, owl or frog (anything else is a fox). */
	void SetAnimal(const FString& Id);
	const FString& GetAnimal() const { return AnimalId; }

private:
	enum class EEars : uint8 { None, Pointed, Round, Long, Tuft };
	enum class ETail : uint8 { None, Bushy, Stub, Thin };
	struct FAnimalSpec
	{
		const TCHAR* Id;
		uint32 Body;
		uint32 Belly;
		EEars Ears;
		ETail Tail;
	};
	static const FAnimalSpec& SpecFor(const FString& Id);

	UMaterialInstanceDynamic* Tint(uint32 Hex);

	/** Adds a sphere or cone using the browser's numbers: unit-radius shapes, x east, y up, z south. */
	void AddPart(bool bCone, UMaterialInstanceDynamic* Material, const FVector& Scale, const FVector& Position, double RotX = 0.0);

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> BaseMaterial;

	UPROPERTY()
	TArray<TObjectPtr<UStaticMeshComponent>> Parts;

	UPROPERTY()
	TArray<TObjectPtr<UMaterialInstanceDynamic>> Tints;

	FString AnimalId;
};
