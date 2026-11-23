// "What's new": the release notes the server keeps (GET /v1/news, docs/PROTOCOL.md "What is new"),
// made ready for the card a game shows on arriving. The card itself is menu.js; the Windows game's is
// AEarthWalkHUD::OpenNews and SEarthMenu::ShowNews.
//
// No three.js and no page here: this file is also run by the server's tests.

/** Said beside a thing that only the other game has so far. */
export const ELSEWHERE = { windows: "In the Windows game so far; coming to this one.", browser: "In the browser game so far; coming to this one." };

/**
 * The releases to tell of, from what the server answered. `game` is the game doing the telling
 * ("browser" or "windows"): a thing marked as being in the other one only gets a note saying so.
 * A release that is all in the other game says so once, under its title (`note`), not on every line.
 * `first` is true for somebody who has never seen the notes: they are told of the newest things only,
 * not of everything there ever was.
 * @returns {{ version: string, title: string, note: string, items: { text: string, note: string }[] }[]}
 */
export function newsCard(news, game = "browser", first = false) {
  const out = [];
  for (const entry of Array.isArray(news) ? news : []) {
    if (!entry || typeof entry.version !== "string" || typeof entry.title !== "string" || !Array.isArray(entry.items)) continue;
    const items = [];
    for (const item of entry.items) {
      if (!item || typeof item.text !== "string") continue;
      items.push({ text: item.text, note: item.in && item.in !== game ? ELSEWHERE[item.in] ?? "" : "" });
    }
    const all = items.length > 0 && !!items[0].note && items.every((item) => item.note === items[0].note);
    out.push({ version: entry.version, title: entry.title, note: all ? items[0].note : "", items: all ? items.map((item) => ({ text: item.text, note: "" })) : items });
  }
  return first ? out.slice(0, 1) : out;
}
