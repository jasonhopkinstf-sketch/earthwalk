#include "EarthLook.h"

#include "EarthSky.h"
#include "EarthWalkGameMode.h"
#include "EarthWalkSettings.h"
#include "EarthWorld.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/CommandLine.h"
#include "Misc/Parse.h"

namespace
{
	/** What /look chose in this run; it wins over the command line, which is only where a run starts. */
	TOptional<EEarthLook> Chosen;

	/** One dial of a material, as each look sets it. */
	struct FDial
	{
		const TCHAR* Name;
		float Barnyard;
		float Flat;
	};

	// The painted surfaces. Flat: no brushwork. Vivid: the colour brighter than it was sent (the server
	// paints houses for the barnyard look). Marks: how strongly tiles, bricks and grass strokes show.
	const FDial PaintDials[] = {
		{ TEXT("Flat"), 0.f, 1.f },
		{ TEXT("Vivid"), 0.f, 0.15f },
		{ TEXT("Marks"), 1.f, 0.5f },
	};

	// The ink pass (InkCode in EarthWalkAssetsCommandlet.cpp). The barnyard column is what the material
	// is built with. Flat: a wider, black line, drawn at every change of colour too, that thins out
	// and gets thinner with distance (a far hillside of trees would otherwise be solid black), and is
	// left off tufts of grass and flowers, which it would blot out; the three levels of
	// light brought close together, so a wall in shade is nearly the colour of a wall in sun; the
	// surface's own colour under that light (Plain) and not the sky's blue in the shade; and the flat
	// light kept all the way to the horizon (ToonFade 0).
	const FDial InkDials[] = {
		{ TEXT("InkWidth"), 1.3f, 2.3f },
		{ TEXT("InkStrength"), 0.9f, 1.f },
		{ TEXT("InkFar"), 0.25f, 0.5f },
		{ TEXT("FarWidth"), 1.f, 0.45f },
		{ TEXT("SmallInk"), 1.f, 0.f },
		{ TEXT("InkBlack"), 0.f, 1.f },
		{ TEXT("Plain"), 0.f, 1.f },
		{ TEXT("DepthEdge"), 0.02f, 0.02f },
		{ TEXT("NormalEdge"), 0.35f, 0.35f },
		{ TEXT("PaintEdge"), 0.2f, 0.16f },
		{ TEXT("PaintInk"), 0.6f, 1.f },
		{ TEXT("Band1"), 0.9f, 0.9f },
		{ TEXT("Band2"), 2.2f, 2.2f },
		{ TEXT("Soft"), 0.06f, 0.02f },
		{ TEXT("Level0"), 0.68f, 1.2f },
		{ TEXT("Level1"), 1.4f, 1.45f },
		{ TEXT("Level2"), 1.65f, 1.55f },
		{ TEXT("FadeStart"), 12000.f, 5000.f },
		{ TEXT("FadeEnd"), 60000.f, 40000.f },
		{ TEXT("ToonFade"), 1.f, 0.f },
	};

	// The sky. Only what differs between the looks is here; the rest stays as the material was built.
	const FDial SkyDials[] = {
		{ TEXT("Flat"), 0.f, 1.f },
		{ TEXT("CloudInk"), 1.f, 1.7f },
	};

	template <int32 N>
	void Turn(UMaterialInstanceDynamic* Material, const FDial (&Dials)[N])
	{
		const bool bFlat = EarthLook::Current() == EEarthLook::Flat;
		for (const FDial& Dial : Dials)
		{
			Material->SetScalarParameterValue(Dial.Name, bFlat ? Dial.Flat : Dial.Barnyard);
		}
	}

	/** -EWInk=Band1:0.9,InkWidth:2 and the like: values to try for one run, on top of the look's own. */
	void Try(UMaterialInstanceDynamic* Material, const TCHAR* Switch)
	{
		FString Tries;
		if (!FParse::Value(FCommandLine::Get(), Switch, Tries, /*bShouldStopOnSeparator*/ false))
		{
			return;
		}
		TArray<FString> Parts;
		Tries.ParseIntoArray(Parts, TEXT(","));
		for (const FString& Part : Parts)
		{
			FString Name, Value;
			if (Part.Split(TEXT(":"), &Name, &Value))
			{
				Material->SetScalarParameterValue(FName(*Name.TrimStartAndEnd()), FCString::Atof(*Value));
			}
		}
	}
}

EEarthLook EarthLook::Current()
{
	if (Chosen.IsSet())
	{
		return Chosen.GetValue();
	}
	FString Text;
	EEarthLook Look = EEarthLook::Barnyard;
	if (!FEarthWalkConfig::HasOverride(TEXT("Look"), Text) || !Parse(Text, Look))
	{
		Parse(GetDefault<UEarthWalkSettings>()->Look, Look);
	}
	return Look;
}

const TCHAR* EarthLook::Name(EEarthLook Look)
{
	return Look == EEarthLook::Flat ? TEXT("flat") : TEXT("barnyard");
}

bool EarthLook::Parse(const FString& Text, EEarthLook& Out)
{
	const FString Asked = Text.TrimStartAndEnd();
	if (Asked.Equals(TEXT("flat"), ESearchCase::IgnoreCase))
	{
		Out = EEarthLook::Flat;
		return true;
	}
	if (Asked.Equals(TEXT("barnyard"), ESearchCase::IgnoreCase))
	{
		Out = EEarthLook::Barnyard;
		return true;
	}
	return false;
}

void EarthLook::Choose(UWorld* World, EEarthLook Look)
{
	Chosen = Look;
	FEarthWalkConfig::Save(TEXT("Look"), Name(Look));
	if (!World)
	{
		return;
	}
	if (AEarthWorld* Earth = AEarthWorld::Get(World))
	{
		Earth->ApplyLook();
	}
	if (AEarthWalkGameMode* Mode = World->GetAuthGameMode<AEarthWalkGameMode>())
	{
		Mode->ApplyLook();
	}
	for (TActorIterator<AEarthSky> Sky(World); Sky; ++Sky)
	{
		Sky->ApplyLook();
	}
}

void EarthLook::PaintSurface(UMaterialInstanceDynamic* Material)
{
	if (Material)
	{
		Turn(Material, PaintDials);
		Try(Material, TEXT("-EWPaint="));
	}
}

void EarthLook::TuneInk(UMaterialInstanceDynamic* Ink)
{
	if (!Ink)
	{
		return;
	}
	Turn(Ink, InkDials);
	for (const TPair<FString, float>& Pair : GetDefault<UEarthWalkSettings>()->InkTuning)
	{
		Ink->SetScalarParameterValue(FName(*Pair.Key), Pair.Value);
	}
	Try(Ink, TEXT("-EWInk="));
}

void EarthLook::TuneSky(UMaterialInstanceDynamic* Sky)
{
	if (Sky)
	{
		Turn(Sky, SkyDials);
		Try(Sky, TEXT("-EWSky="));
	}
}
