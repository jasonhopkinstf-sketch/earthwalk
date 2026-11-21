#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "EarthSounds.generated.h"

class UAudioComponent;
class USoundWaveProcedural;

/**
 * Sounds, made by code like everything else in EarthWalk: there are no recordings. Each call is a
 * short tune for an oscillator, shaped by filters, worked out into a wave when it is first wanted,
 * and played from where the animal stands. The recipes are those of server/public/js/sounds.js, so
 * a moo is the same moo in both games.
 *
 * /sound on|off turns it on and off; -EWSoundDump=<folder> writes every voice as a .wav file to listen to.
 */
UCLASS()
class UEarthSounds : public UObject
{
	GENERATED_BODY()

public:
	/** Makes the voices that play the sounds; they travel with Owner. */
	void Setup(AActor* Owner);

	/**
	 * Plays one call at a place in the world (engine units). Pitch near 1 makes each animal's voice its own.
	 * Kind is one of: moo, baa, neigh, cluck, squawk, quack, coo, caw, woof, meow, bray, toot, chug, whistle.
	 * Returns false when sound is off or too much is already playing.
	 */
	bool Play(const TCHAR* Kind, const FVector& Where, double Pitch, const FVector& Ears);

	/** Call every frame: frees the voices that have finished. */
	void Tick();

	void SetEnabled(bool bOn);
	bool IsEnabled() const { return bEnabled; }
	/** How many calls have been played, for the log. */
	int32 NumPlayed() const { return Played; }

	/** The wave of one call: mono, 16 bits, SampleRate a second. False for a voice that does not exist. */
	static bool Synthesise(const FString& Kind, double Pitch, TArray<int16>& Out);
	static bool WriteWavFiles(const FString& Folder);
	static constexpr int32 SampleRate = 44100;

private:
	struct FVoice
	{
		double Until = 0.0; // when it will have finished
		bool bBusy = false;
	};

	UPROPERTY()
	TArray<TObjectPtr<UAudioComponent>> Players;

	UPROPERTY()
	TArray<TObjectPtr<USoundWaveProcedural>> Waves;

	TArray<FVoice> Voices;
	/** Waves already worked out, by voice and pitch. */
	TMap<FString, TArray<int16>> Cache;
	bool bEnabled = true;
	int32 Played = 0;
};
