#include "EarthFilePick.h"

#include "Framework/Application/SlateApplication.h"
#include "GenericPlatform/GenericWindow.h"
#include "Widgets/SWindow.h"

#if PLATFORM_WINDOWS
#include "Windows/WindowsHWrapper.h"
#include "Windows/AllowWindowsPlatformTypes.h"
#include <commdlg.h>
#include "Windows/HideWindowsPlatformTypes.h"
#endif

bool EarthPickFile(const FString& Title, const FString& Kinds, FString& OutFile)
{
#if PLATFORM_WINDOWS
	// The box wants its kinds as words with a nothing after each, and two at the end.
	TArray<TCHAR> Filter;
	for (const TCHAR Ch : Kinds)
	{
		Filter.Add(Ch == TEXT('|') ? TEXT('\0') : Ch);
	}
	Filter.Add(TEXT('\0'));
	Filter.Add(TEXT('\0'));
	TCHAR File[1024] = { 0 };
	OPENFILENAMEW Ask;
	FMemory::Memzero(Ask);
	Ask.lStructSize = sizeof(Ask);
	if (FSlateApplication::IsInitialized())
	{
		const TSharedPtr<SWindow> Window = FSlateApplication::Get().GetActiveTopLevelWindow();
		if (Window.IsValid() && Window->GetNativeWindow().IsValid())
		{
			Ask.hwndOwner = static_cast<HWND>(Window->GetNativeWindow()->GetOSWindowHandle());
		}
	}
	Ask.lpstrFilter = Filter.GetData();
	Ask.lpstrFile = File;
	Ask.nMaxFile = UE_ARRAY_COUNT(File);
	Ask.lpstrTitle = *Title;
	// (Choosing a file must not move the game to that folder: it finds its own files from where it started.)
	Ask.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY | OFN_EXPLORER;
	if (!::GetOpenFileNameW(&Ask))
	{
		return false;
	}
	OutFile = File;
	return true;
#else
	return false;
#endif
}
