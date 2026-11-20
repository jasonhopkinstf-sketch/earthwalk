#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "EarthWalkAssetsCommandlet.generated.h"

/**
 * Builds the project's art assets from code, so nothing has to be made by hand in the editor:
 * imports the textures in game/Textures (fetched by game/Tools/fetch-textures.ps1) and creates
 * the world materials under /Game/EarthWalk. Run with game\Tools\build-assets.cmd, or:
 *   UnrealEditor-Cmd.exe EarthWalk.uproject -run=EarthWalkAssets
 */
UCLASS()
class UEarthWalkAssetsCommandlet : public UCommandlet
{
	GENERATED_BODY()

public:
	UEarthWalkAssetsCommandlet();

	virtual int32 Main(const FString& Params) override;
};
