// What is new: the release notes, in plain words for the people who play, newest first. A game asks
// for the ones since the version its player last saw (`GET /v1/news?since=0.2.42`) and shows them on
// arriving, so nobody has to find out by accident what has changed.
//
// A release adds an entry at the top for its version: test/news.test.ts fails when the version in
// package.json has no entry. `in` marks a thing that only one of the two games has so far; the other
// game says so beside it.

export interface NewsItem { text: string; in?: "browser" | "windows" }
export interface NewsEntry { version: string; date: string; title: string; items: NewsItem[] }

export const NEWS: NewsEntry[] = [
  {
    version: "0.2.45", date: "2026-11-23", title: "Easier to find your way about",
    items: [
      { text: "Press Tab to see everything you can do, and click it. Nothing needs a typed command any more.", in: "windows" },
      { text: "A row of buttons along the bottom for the things you do most. Z hides it.", in: "windows" },
      { text: "Talk to an animal, a car or a tree with T: it answers in a speech bubble of its own, with things to say that you can click.", in: "windows" },
      { text: "A little map in the top right corner shows your friends, doors that open, stations, cars and the way you are going. M makes it bigger.", in: "windows" },
      { text: "A taxi, or your own car, really drives you where you asked. A taxi waits for you on the street: look for the T on the map." },
      { text: "Taxis tell you a story on the way, about somebody they once drove." },
      { text: "While you ride or are carried, V looks down from above, then from high up over the rooftops.", in: "windows" },
      { text: "This card: what is new since you were last here. It is in the Tab menu too.", in: "windows" },
    ],
  },
  {
    version: "0.2.44", date: "2026-11-23", title: "A house of your own, food, and games with animals",
    items: [
      { text: "Make a house your own: your name over the door, your choice of furniture, your prizes on show.", in: "browser" },
      { text: "Five hearts and a lunch box. Animals, trees and real shops give food; a good mix fills your hearts.", in: "browser" },
      { text: "Cook in your own kitchen, and give food to a friend.", in: "browser" },
      { text: "Teach your companion tricks, feed hungry wild animals, raise a chick, a lamb, a piglet or a calf in your garden, and run an agility course.", in: "browser" },
      { text: "While riding or being carried, V looks down from above." },
    ],
  },
  {
    version: "0.2.43", date: "2026-11-23", title: "A steadier world",
    items: [
      { text: "Big cities build without the server running out of breath." },
    ],
  },
  {
    version: "0.2.42", date: "2026-11-23", title: "Real places look like themselves",
    items: [
      { text: "Cars that look like cars: a saloon, a van and a taxi, each in its own paint." },
      { text: "Famous places stand in their real shapes where the map has them: the Sky Tower, the Eiffel Tower." },
      { text: "Buildings take their real colours, roofs and heights where somebody has mapped them." },
      { text: "Shops, churches, schools and hospitals look like what they are, with their names on a board." },
      { text: "Indoors, the camera stays under the ceiling.", in: "windows" },
    ],
  },
  {
    version: "0.2.41", date: "2026-11-22", title: "A flat cartoon look",
    items: [
      { text: "A second look for the whole world: flat bright colour and bold black lines. Switch it in the Tab menu.", in: "windows" },
      { text: "Esc twice leaves the game, and where you were is remembered.", in: "windows" },
    ],
  },
];

/** Compares two versions like "0.2.45": below zero when `a` is the older. Anything that is not a number counts as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split("."), pb = b.split(".");
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (Number.parseInt(pa[i] ?? "0", 10) || 0) - (Number.parseInt(pb[i] ?? "0", 10) || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * The notes newer than `since`, newest first and at most `most` of them; with no `since` (somebody
 * asking to read them, or new here) the newest `most`. `latest` is the newest version there are notes for.
 */
export function newsSince(since: string | null, most = 3, all: NewsEntry[] = NEWS): { latest: string; news: NewsEntry[] } {
  const known = since !== null && /^\d+(\.\d+){0,3}$/.test(since);
  const news = (known ? all.filter((entry) => compareVersions(entry.version, since!) > 0) : all).slice(0, most);
  return { latest: all[0]?.version ?? "", news };
}
