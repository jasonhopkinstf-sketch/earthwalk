#pragma once

#include "CoreMinimal.h"
#include "Components/SceneComponent.h"
#include "EarthIdleMoves.h"
#include "EarthAnimalFigure.generated.h"

class UMaterialInstanceDynamic;
class UMaterialInterface;
class UStaticMesh;
class UStaticMeshComponent;

/** What a figure is doing, for UEarthAnimalFigure::Animate. */
struct FEarthFigureMotion
{
	float Speed = 0.f;    // over the ground, cm a second (of whatever it sits on, when seated)
	float Turn = 0.f;     // degrees a second, to its right
	bool bInAir = false;  // feet off the ground in a jump or a fall
	bool bFlying = false;
	bool bSeated = false; // riding something
};

/**
 * One of the six animals, built from engine spheres and cones. The sizes mirror makeAnimal()
 * in server/public/js/avatars.js, so browser and Unreal players see the same figures.
 * About 1.4 m tall before scaling, feet at the component origin, facing +X.
 *
 * The figure is jointed and moves itself in code: it strides with swinging arms, leaning into a run
 * (the rabbit and frog hop, squashing as they land), breathes, blinks and looks about when standing,
 * throws its arms up in a jump, stretches out to fly, and sits with its feet forward when riding.
 * The sums are the same as stepFigure() in server/public/js/figuremotion.js: keep the two in step.
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

	/** Advances the pose. Call every frame. */
	void Animate(float DeltaSeconds, const FEarthFigureMotion& Motion);

	/** What the figure adds to its standing about from the next Animate on, left standing a while (EarthIdleMoves.h); null for nothing. */
	void SetFidget(const FEarthFidget* Pose)
	{
		bFidget = Pose != nullptr;
		if (Pose)
		{
			Fidget = *Pose;
		}
	}

	/**
	 * The joint the head turns on, for hanging something on the head (a hat) so that it nods and leans
	 * with it. It is at the neck: 0.88 m up the unscaled figure, so a thing placed in the figure's own
	 * measure goes that much lower here. Rebuilt by SetAnimal; null before the first.
	 */
	USceneComponent* HeadJoint() const { return Head.Node; }

	/**
	 * Puts a hat on the figure's head, or (with an empty id, or one this game does not know) takes it
	 * off. Only a hat's id travels between players; each game builds the hat from basic shapes, as it
	 * does the figures. The thirteen hats and their sizes are BUILD in server/public/js/hats.js.
	 */
	void SetHat(const FString& Id);
	const FString& GetHat() const { return HatId; }
	/** True for a hat this game can draw. */
	static bool KnowsHat(const FString& Id);

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

	/** A place the figure bends: a node that turns about At (the browser's measure: x right, y up, z behind, metres). */
	struct FJoint
	{
		USceneComponent* Node = nullptr;
		FVector At = FVector::ZeroVector;
		FVector Rest = FVector::ZeroVector; // the node's own place inside its parent, engine units
	};

	/** What the figure remembers from one moment to the next (newFigureState in figuremotion.js). */
	struct FState
	{
		uint32 Rng = 1;
		float Time = 0.f, Phase = 0.f, Move = 0.f, Run = 0.f, Air = 0.f, Fly = 0.f, Seat = 0.f, Turn = 0.f;
		float BlinkIn = 1.5f, BlinkLeft = 0.f;
		bool bBlinkAgain = false;
		float LookIn = 2.f, Look = 0.f, LookTo = 0.f, Twitch = 0.f;
		int32 TwitchSide = 1;
		float Ear = 0.f, EarSpeed = 0.f, Bounce = 0.f, BounceSpeed = 0.f, LastLift = 0.f;
		bool bWasInAir = false;
	};

	UMaterialInstanceDynamic* Tint(uint32 Hex);
	FJoint AddJoint(const FJoint& Parent, const FVector& At);

	/** Adds a sphere or cone to a joint using the browser's numbers: unit-radius shapes, x east, y up, z south. */
	UStaticMeshComponent* AddPart(const FJoint& Joint, bool bCone, UMaterialInstanceDynamic* Material, const FVector& Scale, const FVector& Position, double RotX = 0.0);

	float Chance();

	UPROPERTY()
	TObjectPtr<UStaticMesh> SphereMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;

	UPROPERTY()
	TObjectPtr<UMaterialInterface> BaseMaterial;

	UPROPERTY()
	TArray<TObjectPtr<UStaticMeshComponent>> Parts;

	UPROPERTY()
	TArray<TObjectPtr<USceneComponent>> Nodes;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	/** The shapes of the hat being worn; they hang on the head joint, so they nod and lean with the head. */
	UPROPERTY()
	TArray<TObjectPtr<USceneComponent>> HatParts;
	FString HatId;

	UPROPERTY()
	TArray<TObjectPtr<UMaterialInstanceDynamic>> Tints;

	FJoint All, Hips, Trunk, Head, Tail;
	FJoint Ears[2], Arms[2], Feet[2]; // left, right
	UStaticMeshComponent* Eyes[2] = { nullptr, nullptr };
	FVector EyeScale = FVector::OneVector;

	FString AnimalId;
	bool bHopper = false; // rabbits and frogs hop rather than stride
	FEarthFidget Fidget;
	bool bFidget = false;
	FState State;
};
