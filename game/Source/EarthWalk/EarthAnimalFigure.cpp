#include "EarthAnimalFigure.h"

#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/MaterialInterface.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	// Where a figure bends (the same places as in server/public/js/avatars.js): x to its right, y up, z behind it.
	const FVector HipsAt(0.0, 0.5, 0.0);
	const FVector NeckAt(0.0, 0.88, 0.0);
	const FVector ShoulderAt(0.3, 0.8, -0.02);
	const FVector HipAt(0.15, 0.42, 0.0);
	const FVector TailRootAt(0.0, 0.42, 0.26);
	constexpr float LegM = 0.32f; // from the hip down to the foot

	/** Browser figure: x east, y up, z south, metres. Engine: X north, Y east, Z up, centimetres. */
	FVector ToEngine(const FVector& P)
	{
		return FVector(-P.Z, P.X, P.Y) * 100.0;
	}

	FVector Mirrored(const FVector& P, double Side)
	{
		return FVector(Side * P.X, P.Y, P.Z);
	}

	/** Turns given as in the pose, in radians: nose up, to its right, right side down. */
	FRotator Turned(float Up, float Right, float RightDown)
	{
		return FRotator(FMath::RadiansToDegrees(Up), FMath::RadiansToDegrees(Right), FMath::RadiansToDegrees(RightDown));
	}
}

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

UEarthAnimalFigure::FJoint UEarthAnimalFigure::AddJoint(const FJoint& Parent, const FVector& At)
{
	UObject* Outer = GetOwner() ? static_cast<UObject*>(GetOwner()) : static_cast<UObject*>(this);
	USceneComponent* Node = NewObject<USceneComponent>(Outer);
	Node->SetMobility(EComponentMobility::Movable);
	Node->SetupAttachment(Parent.Node ? Parent.Node : this);
	FJoint Joint;
	Joint.Node = Node;
	Joint.At = At;
	Joint.Rest = ToEngine(At - Parent.At);
	Node->SetRelativeLocation(Joint.Rest);
	Node->SetVisibility(IsVisible());
	Node->RegisterComponent();
	Nodes.Add(Node);
	return Joint;
}

UStaticMeshComponent* UEarthAnimalFigure::AddPart(const FJoint& Joint, bool bCone, UMaterialInstanceDynamic* Material, const FVector& Scale, const FVector& Position, double RotX)
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
	Part->SetupAttachment(Joint.Node);
	// Unit-radius shapes in the browser; 100 cm shapes in the engine.
	Part->SetRelativeLocation(ToEngine(Position - Joint.At));
	Part->SetRelativeRotation(FRotator(FMath::RadiansToDegrees(RotX), 0.0, 0.0));
	Part->SetRelativeScale3D(bCone
		? FVector(2.0 * Scale.Z, 2.0 * Scale.X, Scale.Y)
		: FVector(2.0 * Scale.Z, 2.0 * Scale.X, 2.0 * Scale.Y));
	Part->SetVisibility(IsVisible());
	Part->RegisterComponent();
	Parts.Add(Part);
	return Part;
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
	for (USceneComponent* Node : Nodes)
	{
		if (Node)
		{
			Node->DestroyComponent();
		}
	}
	Parts.Reset();
	Nodes.Reset();
	Tints.Reset();
	bHopper = AnimalId == TEXT("rabbit") || AnimalId == TEXT("frog");
	// Each figure blinks and looks about in its own time.
	State = FState();
	State.Rng = (GetTypeHash(AnimalId) ^ static_cast<uint32>(FMath::Rand())) | 1u;

	UMaterialInstanceDynamic* Body = Tint(A.Body);
	UMaterialInstanceDynamic* Belly = Tint(A.Belly);
	UMaterialInstanceDynamic* Dark = Tint(0x1c1c1c);

	All = AddJoint(FJoint(), FVector::ZeroVector); // squashes and stretches from the feet up
	Hips = AddJoint(All, HipsAt);                  // the whole figure lifts and leans here
	Trunk = AddJoint(Hips, HipsAt);
	Head = AddJoint(Hips, NeckAt);
	Tail = AddJoint(Trunk, TailRootAt);

	AddPart(Trunk, false, Body, FVector(0.32, 0.4, 0.3), FVector(0, 0.55, 0));
	AddPart(Trunk, false, Belly, FVector(0.24, 0.3, 0.2), FVector(0, 0.52, -0.14));
	AddPart(Head, false, Body, FVector(0.27, 0.25, 0.26), FVector(0, 1.1, 0));
	if (AnimalId == TEXT("owl"))
	{
		AddPart(Head, true, Tint(0xe0a030), FVector(0.05, 0.12, 0.05), FVector(0, 1.06, -0.28), -UE_DOUBLE_PI / 2.0); // beak
	}
	else
	{
		AddPart(Head, false, Belly, FVector(0.13, 0.1, 0.12), FVector(0, 1.04, -0.22)); // muzzle
		AddPart(Head, false, Dark, FVector(0.04, 0.035, 0.03), FVector(0, 1.08, -0.34)); // nose
	}
	const bool bFrog = AnimalId == TEXT("frog");
	for (int32 i = 0; i < 2; ++i)
	{
		const double Side = i == 0 ? -1.0 : 1.0;
		if (bFrog)
		{
			AddPart(Head, false, Belly, FVector(0.09), FVector(Side * 0.14, 1.32, -0.08)); // bulging eye
		}
		Eyes[i] = AddPart(Head, false, Dark, FVector(0.04, 0.05, 0.03), bFrog ? FVector(Side * 0.14, 1.33, -0.16) : FVector(Side * 0.11, 1.16, -0.22));
		EyeScale = Eyes[i]->GetRelativeScale3D();
		Feet[i] = AddJoint(Hips, Mirrored(HipAt, Side));
		AddPart(Feet[i], false, Body, FVector(0.12, 0.1, 0.17), FVector(Side * 0.15, 0.1, -0.03));
		Arms[i] = AddJoint(Trunk, Mirrored(ShoulderAt, Side));
		AddPart(Arms[i], false, Body, FVector(0.09, 0.2, 0.1), FVector(Side * 0.34, 0.62, -0.02));
		Ears[i] = FJoint();
		switch (A.Ears)
		{
		case EEars::Pointed:
			Ears[i] = AddJoint(Head, FVector(Side * 0.16, 1.3, 0));
			AddPart(Ears[i], true, Body, FVector(0.09, 0.2, 0.06), FVector(Side * 0.16, 1.4, 0));
			break;
		case EEars::Round:
			Ears[i] = AddJoint(Head, FVector(Side * 0.2, 1.27, 0));
			AddPart(Ears[i], false, Body, FVector(0.1, 0.1, 0.05), FVector(Side * 0.2, 1.32, 0));
			break;
		case EEars::Long:
			Ears[i] = AddJoint(Head, FVector(Side * 0.1, 1.28, 0.02));
			AddPart(Ears[i], false, Body, FVector(0.06, 0.26, 0.04), FVector(Side * 0.1, 1.52, 0.02));
			break;
		case EEars::Tuft:
			Ears[i] = AddJoint(Head, FVector(Side * 0.18, 1.29, -0.04));
			AddPart(Ears[i], true, Body, FVector(0.05, 0.14, 0.05), FVector(Side * 0.18, 1.36, -0.04));
			break;
		default:
			break;
		}
	}
	switch (A.Tail)
	{
	case ETail::Bushy:
		AddPart(Tail, false, Body, FVector(0.12, 0.12, 0.3), FVector(0, 0.42, 0.42), -0.6);
		AddPart(Tail, false, Belly, FVector(0.09, 0.09, 0.1), FVector(0, 0.56, 0.62));
		break;
	case ETail::Stub: AddPart(Tail, false, Belly, FVector(0.09), FVector(0, 0.36, 0.3)); break;
	case ETail::Thin: AddPart(Tail, false, Body, FVector(0.04, 0.04, 0.34), FVector(0, 0.5, 0.42), -0.9); break;
	default: break;
	}
}

/** The next number between 0 and 1 in this figure's own run of chances. */
float UEarthAnimalFigure::Chance()
{
	State.Rng = State.Rng * 1664525u + 1013904223u;
	return static_cast<float>(State.Rng / 4294967296.0);
}

void UEarthAnimalFigure::Animate(float DeltaSeconds, const FEarthFigureMotion& Motion)
{
	if (!IsVisible() || Parts.Num() == 0 || DeltaSeconds <= 0.f)
	{
		return;
	}
	// ---- the same sums as stepFigure() in server/public/js/figuremotion.js, line for line
	FState& S = State;
	const float Dt = FMath::Min(DeltaSeconds, 0.25f);
	const auto Ease = [Dt](float From, float To, float Rate) { return From + (To - From) * (1.f - FMath::Exp(-Rate * Dt)); };
	const float SpeedM = Motion.Speed / 100.f;
	S.Time += Dt;
	const float Speed = Motion.bSeated ? 0.f : SpeedM;
	S.Move = Ease(S.Move, FMath::Clamp(Speed / 2.5f, 0.f, 1.f), 8.f);
	S.Run = Ease(S.Run, FMath::Clamp((Speed - 5.5f) / 4.5f, 0.f, 1.f), 6.f);
	S.Fly = Ease(S.Fly, Motion.bFlying ? 1.f : 0.f, 5.f);
	S.Seat = Ease(S.Seat, Motion.bSeated ? 1.f : 0.f, 8.f);
	S.Air = Ease(S.Air, Motion.bInAir && !Motion.bFlying && !Motion.bSeated ? 1.f : 0.f, 12.f);
	S.Turn = Ease(S.Turn, FMath::Clamp(FMath::DegreesToRadians(Motion.Turn), -4.f, 4.f), 6.f);
	const float OnFoot = (1.f - S.Fly) * (1.f - S.Seat);
	const float Stride = S.Move * OnFoot * (1.f - S.Air);
	const float Still = (1.f - S.Move) * OnFoot;

	const float StrideLength = bHopper ? 1.3f + 0.12f * Speed : 0.9f + 0.22f * Speed;
	S.Phase = FMath::Fmod(S.Phase + Dt * Speed * UE_TWO_PI / StrideLength, UE_TWO_PI);
	const float Sin = FMath::Sin(S.Phase), Cos = FMath::Cos(S.Phase);

	// ---- on foot
	float Lift = 0.f, Squash = 1.f;
	float Pitch = (0.06f * S.Move + 0.2f * S.Run) * OnFoot;
	float Roll = 0.f, Twist = 0.f, HeadPitch = 0.f;
	float ArmL = 0.f, ArmR = 0.f, ArmOutL = 0.06f, ArmOutR = 0.06f;
	float FootL = 0.f, FootR = 0.f, LiftL = 0.f, LiftR = 0.f;
	float TailYaw = 0.f, TailUp = 0.45f * S.Run;
	if (bHopper)
	{
		const float U = S.Phase / UE_TWO_PI;
		const float Up = U < 0.6f ? FMath::Sin(UE_PI * U / 0.6f) : 0.f;
		const float Crouch = U < 0.6f ? 0.f : FMath::Sin(UE_PI * (U - 0.6f) / 0.4f);
		Lift = Up * (0.2f + 0.12f * S.Run) * Stride;
		Squash = 1.f + (Up * 0.1f - Crouch * 0.16f) * Stride;
		FootL = FootR = (Up > 0.f ? -0.6f * Up : 0.35f * Crouch) * Stride;
		ArmL = ArmR = (0.7f * Up - 0.3f * Crouch) * Stride;
		Pitch += 0.12f * Up * Stride;
		HeadPitch = (0.1f * Crouch - 0.08f * Up) * Stride;
		TailUp += 0.3f * Up * Stride;
	}
	else
	{
		const float Reach = (0.55f + 0.35f * S.Run) * Stride;
		FootL = Sin * Reach;
		FootR = -Sin * Reach;
		const float Step = (0.07f + 0.08f * S.Run) * Stride;
		LiftL = FMath::Max(0.f, Cos) * Step;
		LiftR = FMath::Max(0.f, -Cos) * Step;
		Lift = (0.5f + 0.5f * FMath::Cos(2.f * S.Phase)) * (0.03f + 0.04f * S.Run) * Stride;
		LiftL -= Lift;
		LiftR -= Lift;
		Roll = Sin * 0.05f * Stride * (1.f - S.Run);
		Twist = Sin * 0.12f * Stride;
		const float Swing = (0.6f + 0.5f * S.Run) * Stride;
		ArmL = -Sin * Swing;
		ArmR = Sin * Swing;
		ArmOutL = ArmOutR = 0.06f + 0.22f * S.Run * Stride;
		HeadPitch = FMath::Cos(2.f * S.Phase) * 0.03f * Stride;
		TailYaw = -Sin * 0.35f * Stride;
	}
	Roll += FMath::Clamp(S.Turn * 0.05f, -0.2f, 0.2f) * S.Move * OnFoot;

	// ---- standing about
	const float Breath = FMath::Sin(S.Time * 2.1f);
	Lift += Breath * 0.004f * Still;
	Roll += FMath::Sin(S.Time * 0.63f) * 0.02f * Still;
	ArmOutL += Breath * 0.02f * Still;
	ArmOutR += Breath * 0.02f * Still;
	TailYaw += FMath::Sin(S.Time * 3.1f) * 0.3f * (1.f - 0.7f * S.Move) * (1.f - S.Fly);

	// ---- off the ground in a jump or a fall
	ArmOutL += 1.0f * S.Air;
	ArmOutR += 1.0f * S.Air;
	FootL += 0.45f * S.Air;
	FootR -= 0.3f * S.Air;
	LiftL += 0.06f * S.Air;
	TailUp += 0.3f * S.Air;

	if (S.bWasInAir && !Motion.bInAir && !Motion.bFlying && !Motion.bSeated)
	{
		S.BounceSpeed = -1.6f;
	}
	S.bWasInAir = Motion.bInAir;
	S.BounceSpeed += (-140.f * S.Bounce - 14.f * S.BounceSpeed) * Dt;
	S.Bounce = FMath::Clamp(S.Bounce + S.BounceSpeed * Dt, -0.25f, 0.25f);
	Squash += S.Bounce;

	// ---- flying
	const float Forward = FMath::Clamp(SpeedM / 30.f, 0.f, 1.f) * S.Fly;
	const float Hover = S.Fly - Forward;
	Pitch += 1.2f * Forward;
	Roll += FMath::Clamp(S.Turn * 0.25f, -0.5f, 0.5f) * S.Fly;
	Lift += FMath::Sin(S.Time * 2.3f) * 0.04f * Hover;
	const float Flap = FMath::Sin(S.Time * 7.f) * 0.07f;
	ArmOutL += (1.3f + Flap) * S.Fly;
	ArmOutR += (1.3f + Flap) * S.Fly;
	FootL += (FMath::Sin(S.Time * 2.3f + 1.f) * 0.15f - 0.1f) * Hover - 0.55f * Forward;
	FootR += (FMath::Sin(S.Time * 2.3f + 2.2f) * 0.15f - 0.1f) * Hover - 0.7f * Forward;
	TailUp += 0.5f * Forward;
	HeadPitch -= 0.85f * Forward;

	// ---- sitting on something
	const float Jog = FMath::Sin(S.Time * 9.f) * 0.012f * FMath::Clamp(SpeedM / 3.f, 0.f, 1.f);
	Lift += (-0.1f + Jog) * S.Seat;
	Pitch -= 0.05f * S.Seat;
	FootL += 1.15f * S.Seat;
	FootR += 1.15f * S.Seat;
	ArmL += 0.75f * S.Seat;
	ArmR += 0.75f * S.Seat;
	ArmOutL += 0.15f * S.Seat;
	ArmOutR += 0.15f * S.Seat;

	// ---- the head
	S.LookIn -= Dt;
	if (S.LookIn <= 0.f)
	{
		S.LookIn = 1.8f + 3.5f * Chance();
		S.LookTo = Chance() < 0.4f ? 0.f : (Chance() - 0.5f) * 1.3f;
		if (Chance() < 0.5f)
		{
			S.Twitch = 1.f;
			S.TwitchSide = Chance() < 0.5f ? 0 : 1;
		}
	}
	const float Idle = FMath::Max(Still, S.Seat);
	S.Look = Ease(S.Look, S.LookTo * Idle, 3.5f);
	S.Twitch = FMath::Max(0.f, S.Twitch - Dt * 5.f);

	S.BlinkIn -= Dt;
	if (S.BlinkIn <= 0.f && S.BlinkLeft <= 0.f)
	{
		S.BlinkLeft = 0.13f;
		S.BlinkIn = S.bBlinkAgain ? 2.f + 4.f * Chance() : Chance() < 0.2f ? 0.28f : 2.f + 4.f * Chance();
		S.bBlinkAgain = S.BlinkIn < 1.f;
	}
	S.BlinkLeft = FMath::Max(0.f, S.BlinkLeft - Dt);

	const float Rise = (Lift - S.LastLift) / Dt;
	S.LastLift = Lift;
	const float EarRest = 0.35f * S.Run * OnFoot + 0.9f * Forward + 0.25f * S.Air;
	S.EarSpeed += ((EarRest - S.Ear) * 90.f - S.EarSpeed * 9.f + FMath::Clamp(Rise, -3.f, 3.f) * 14.f) * Dt;
	S.Ear = FMath::Clamp(S.Ear + S.EarSpeed * Dt, -0.5f, 1.3f);

	HeadPitch -= Pitch * 0.6f * OnFoot;
	const float EarTwitch = FMath::Sin(S.Twitch * UE_PI) * 0.35f;
	const float FootSpread = 0.1f * S.Seat;
	const float FootArc = FMath::Max3(S.Seat, S.Fly, S.Air);

	// ---- the pose on the joints. A lean forward is nose down; the browser's sideways turns are mirrored here.
	const float Wide = 1.f / FMath::Sqrt(FMath::Max(Squash, 0.3f));
	All.Node->SetRelativeScale3D(FVector(Wide, Wide, Squash));
	Hips.Node->SetRelativeLocationAndRotation(Hips.Rest + FVector(0.0, 0.0, Lift * 100.0), Turned(-Pitch, 0.f, Roll));
	Trunk.Node->SetRelativeRotation(Turned(0.f, -Twist, 0.f));
	const float Breathe = 1.f + Breath * 0.015f * Still;
	Trunk.Node->SetRelativeScale3D(FVector(Breathe, Breathe, 1.0));
	Head.Node->SetRelativeRotation(Turned(-HeadPitch, S.Look, S.Look * 0.15f));
	Tail.Node->SetRelativeRotation(Turned(-TailUp, -TailYaw, 0.f));
	const float ArmSwing[2] = { ArmL, ArmR };
	const float ArmOut[2] = { ArmOutL, ArmOutR };
	const float FootSwing[2] = { FootL, FootR };
	const float FootLift[2] = { LiftL, LiftR };
	const bool bShut = S.BlinkLeft > 0.f;
	for (int32 i = 0; i < 2; ++i)
	{
		const float Side = i == 0 ? -1.f : 1.f;
		if (Ears[i].Node)
		{
			Ears[i].Node->SetRelativeRotation(Turned(S.Ear, 0.f, S.TwitchSide == i ? Side * EarTwitch : 0.f));
		}
		Arms[i].Node->SetRelativeRotation(Turned(ArmSwing[i], 0.f, -Side * ArmOut[i]));
		const float Swing = FootSwing[i];
		const FVector Moved(
			LegM * FMath::Sin(Swing) * 100.0,
			Side * FootSpread * 100.0,
			(FootLift[i] + LegM * (1.f - FMath::Cos(Swing)) * FootArc) * 100.0);
		Feet[i].Node->SetRelativeLocationAndRotation(Feet[i].Rest + Moved, Turned(Swing * 0.6f, 0.f, 0.f));
		if (Eyes[i])
		{
			Eyes[i]->SetRelativeScale3D(FVector(EyeScale.X, EyeScale.Y, bShut ? EyeScale.Z * 0.12 : EyeScale.Z));
		}
	}
}
