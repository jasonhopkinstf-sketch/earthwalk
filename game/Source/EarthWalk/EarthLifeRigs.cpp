#include "EarthLifeRigs.h"

FQuat EarthRigs::Turned(double AboutX, double AboutY, double AboutZ)
{
	// The browser's axes are x east, y up, z south (right-handed); a figure's here are X forward,
	// Y right, Z up (left-handed). The same turn is about the matching axis, the other way round:
	// x is our Y, y is our Z, and z is our -X.
	const FQuat X(FVector(0.0, 1.0, 0.0), -AboutX);
	const FQuat Y(FVector(0.0, 0.0, 1.0), -AboutY);
	const FQuat Z(FVector(1.0, 0.0, 0.0), AboutZ);
	return Y * X * Z;
}

namespace
{
	FLinearColor Paint(uint32 Rgb)
	{
		return FLinearColor::FromSRGBColor(FColor((Rgb >> 16) & 0xff, (Rgb >> 8) & 0xff, Rgb & 0xff, 255));
	}

	/** Turns the readable table into what the game needs each frame; the rules are those of life.js. */
	void Finish(FEarthRig& Rig)
	{
		double Top = 0.0;
		for (const FEarthRigPart& Part : Rig.Parts)
		{
			const bool bSphere = Part.Shape == EEarthShape::Sphere;
			Top = FMath::Max(Top, Part.At[1] + (bSphere ? Part.Size[1] : Part.Size[1] / 2.0));
		}
		Rig.HeightM = FMath::Max(Top, 0.05);
		for (FEarthRigPart& Part : Rig.Parts)
		{
			const double* At = Part.At;
			const double* Size = Part.Size;
			const bool bSphere = Part.Shape == EEarthShape::Sphere;
			const bool bRound = Part.Shape != EEarthShape::Box; // the browser's round shapes have radius 1, ours are 1 m across
			Part.AtCm = EarthRigs::ToCm(At[0], At[1], At[2]);
			Part.TiltQuat = EarthRigs::Turned(Part.Tilt, 0.0, 0.0);
			Part.Scale = FVector((bRound ? 2.0 : 1.0) * Size[2], (bRound ? 2.0 : 1.0) * Size[0], (bSphere ? 2.0 : 1.0) * Size[1]);
			const double Half = bSphere ? Size[1] : Size[1] / 2.0;
			switch (Part.Role)
			{
			case EEarthRole::None:
				break;
			case EEarthRole::Head: // a head turns about the neck
				Part.PivotCm = EarthRigs::ToCm(Rig.Neck.X, Rig.Neck.Y, Rig.Neck.Z);
				break;
			case EEarthRole::TailUp: // a raised tail stands on its base
				Part.PivotCm = EarthRigs::ToCm(At[0], At[1] - Half, At[2]);
				break;
			case EEarthRole::Wing0:
			case EEarthRole::Wing1:
				// A spread wing flaps from its inner end; a folded one, or a flipper, from its top.
				Part.PivotCm = Size[0] > Size[1]
					? EarthRigs::ToCm(At[0] - FMath::Sign(At[0]) * Size[0], At[1], At[2])
					: EarthRigs::ToCm(At[0], At[1] + Half, At[2]);
				break;
			default: // legs and tails hang from their tops
				Part.PivotCm = EarthRigs::ToCm(At[0], At[1] + (bSphere ? 0.0 : Half), At[2]);
				break;
			}
			if (Part.Colour != FEarthRigPart::CoatA && Part.Colour != FEarthRigPart::CoatB)
			{
				Part.Paint = Paint(Part.Colour);
			}
			const double Across = FMath::Max3((bRound ? 2.0 : 1.0) * Size[0], (bSphere ? 2.0 : 1.0) * Size[1], (bRound ? 2.0 : 1.0) * Size[2]);
			Part.bSmall = !Rig.bVehicle && Across < 0.14 * Rig.HeightM;
		}
		for (const FEarthRigCoat& Coat : Rig.Coats)
		{
			Rig.PaletteA.Add(Paint(Coat.A));
			Rig.PaletteB.Add(Paint(Coat.B));
		}
	}

	// The table is one very long function that runs once. Left to itself the optimiser spends many minutes
	// on it (it stopped finishing at all at sixty figures) and gains nothing, so it is told to leave it alone.
#pragma optimize("", off)
	TMap<FString, FEarthRig> Build()
	{
		TMap<FString, FEarthRig> Rigs;
		const auto Add = [&Rigs](const TCHAR* Name, bool bVehicle) -> FEarthRig&
		{
			FEarthRig& Rig = Rigs.Add(Name);
			Rig.Name = Name;
			Rig.bVehicle = bVehicle;
			return Rig;
		};
#include "EarthLifeRigs.gen.inl"
		for (TPair<FString, FEarthRig>& Pair : Rigs)
		{
			Finish(Pair.Value);
		}
		return Rigs;
	}
#pragma optimize("", on)
}

const FEarthRig* EarthRigs::Find(const FString& Name)
{
	static const TMap<FString, FEarthRig> Rigs = Build();
	return Rigs.Find(Name);
}
