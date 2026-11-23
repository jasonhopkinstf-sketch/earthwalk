#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "EarthPlay.generated.h"

class AActor;
class AEarthWalkHUD;
class UStaticMesh;
class UStaticMeshComponent;

/**
 * Tag, hide and seek, and the round-up (docs/PROTOCOL.md, "Tag, and hide and seek"; the browser's is
 * server/public/js/play.js). The server judges who has been touched, found or penned. Here the field is
 * marked out with a ring of orange flags (a round-up's pen with fence posts and rails), an arrow hangs
 * over whoever is "it" or seeking, the seeker sees nothing while the others hide, whoever is it at tag
 * runs a fifth faster, and a small panel says how things stand.
 *
 * R joins a game that is set up and starts your own; in a round-up T beside an animal has it follow
 * you; /tag, /hide and /herd set one up, and "/tag stop" leaves.
 */
UCLASS()
class UEarthPlay : public UObject
{
	GENERATED_BODY()

public:
	void Setup(AEarthWalkHUD* InHud);
	void Shutdown();
	void Frame(float DeltaSeconds);

	/** Sets a game up where I stand: "tag", "hide" or "herd". */
	void Make(const FString& Kind);
	/** The R key. True when there is a game for it to act on (so that it does not also set up a race). */
	bool Key();
	/** The T key in the middle of a round-up: the animal beside me is told to follow, without stopping to chat. True when a round-up is on. */
	bool Lead();
	void Stop();

	/** True while there is a game in the room, whatever its state. */
	bool IsOn() const;
	const FString& GetPanel() const { return Panel; }
	const FString& GetCount() const { return Count; }

private:
	void Heard();
	void Clear();
	void Say(const FString& Text) const;
	FString NameOf(const FString& Id) const;
	UStaticMeshComponent* AddPart(UStaticMesh* Mesh, uint32 Color);

	TWeakObjectPtr<AEarthWalkHUD> Hud;
	FDelegateHandle PlayHandle;

	UPROPERTY()
	TObjectPtr<AActor> Field; // the ring of flags, or the pen
	UPROPERTY()
	TObjectPtr<UStaticMeshComponent> Arrow;
	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;
	UPROPERTY()
	TObjectPtr<UStaticMesh> ConeMesh;

	struct FFlag { TArray<UStaticMeshComponent*> Parts; bool bPlaced = false; };
	TArray<FFlag> Flags;
	FString Course; // which game the field was marked out for
	// What I last knew of the game, to say what is new.
	bool bBefore = false;
	FString WasState;
	FString WasIt;
	int32 WasPenned = 0;
	TSet<FString> WasFound;
	FString Panel;
	FString Count;
	bool bBlind = false;
	bool bBoosted = false;
	bool bNamesHidden = false;
};
