#pragma once

#include "CoreMinimal.h"

/**
 * Asks the player to choose one file, in the box Windows itself has for it (the game stands still while
 * it is open). Kinds is what may be chosen, as that box wants it: "Pictures|*.png;*.jpg|All files|*.*".
 * False when the player closed the box without choosing.
 */
bool EarthPickFile(const FString& Title, const FString& Kinds, FString& OutFile);
