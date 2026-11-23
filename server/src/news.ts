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
    version: "0.2.48", date: "2026-11-23", title: "The Windows game catches up",
    items: [
      { text: "Windows game: shops, cafés, offices, malls, flats and hotels open. Walk in and through, and talk to the animals who work there." },
      { text: "Windows game: ask the guide (Q) in plain words. Its answer has buttons that take you there." },
      { text: "Windows game: after \"Go to\" you can choose to be flown there, and watch the world go by on the way." },
      { text: "Windows game: tag, hide and seek, and the round-up. They are in the Tab menu; R joins a game a friend has set up." },
      { text: "Windows game: a house built from a floor plan can be walked in, up the stairs and all." },
      { text: "Windows game: a warm light indoors and in tunnels, and a real ball and hoop when your companion does its tricks." },
      { text: "The animals at work in a shop or an office no longer ask you to carry them somewhere." },
      { text: "The world keeps arriving while a big city is being built: the server no longer runs short of memory." },
    ],
  },
  {
    version: "0.2.47", date: "2026-11-23", title: "Bridges, tunnels, and doors that open",
    items: [
      { text: "Bridges are bridges and tunnels are tunnels: walk, drive and ride over and through them. Trains run under the city now." },
      { text: "\"Go to\" finds the place nearest you: the beach down the road, not one across the world. In a car or on an animal, it drives you there." },
      { text: "C calls your car, and X calls a taxi." },
      { text: "\"Take me to...\" works again. A ride told where to go used to say hello and stay where it was." },
      { text: "Shops, cafés, offices, malls, flats and hotels open: walk in and through, and talk to the animals who work there." },
      { text: "Ask the guide (Q) in plain words: where am I, what is near, how do I get to the beach? Its answer has buttons that take you there." },
      { text: "After \"Go to\" you can choose to be flown there, and watch the world go by on the way." },
    ],
  },
  {
    version: "0.2.46", date: "2026-11-23", title: "The two games catch each other up",
    items: [
      { text: "Windows game: five hearts and a lunch box (B), with food from animals and fruit trees, and from the real shops and cafés you stand beside." },
      { text: "Windows game: a house of your own (H), with your name over the door, furniture to choose, a kitchen, and a garden of young animals." },
      { text: "Windows game: teach your companion tricks (K), set up an agility course, and feed the hungry animals that show what they would like." },
      { text: "Browser game: press Tab for everything you can do, with a row of buttons along the bottom (Z hides it)." },
      { text: "Browser game: talking has a speech bubble of its own (T), and a little map sits in the top right corner (M)." },
      { text: "Browser game: the flat cartoon look. Switch it in the Tab menu." },
      { text: "A prize on show in your house can be put down where you stand, turned, or sent back to a wall. There are five new things to buy." },
      { text: "Upload a picture of a real floor plan and your house is built from it inside, with stairs you can walk up.", in: "browser" },
    ],
  },
  {
    version: "0.2.45", date: "2026-11-23", title: "Easier to find your way about",
    items: [
      { text: "Press Tab to see everything you can do, and click it. Nothing needs a typed command any more." },
      { text: "A row of buttons along the bottom for the things you do most. Z hides it." },
      { text: "Talk to an animal, a car or a tree with T: it answers in a speech bubble of its own, with things to say that you can click." },
      { text: "A little map in the top right corner shows your friends, doors that open, stations, cars and the way you are going. M makes it bigger." },
      { text: "A taxi, or your own car, really drives you where you asked. A taxi waits for you on the street: look for the T on the map." },
      { text: "Taxis tell you a story on the way, about somebody they once drove." },
      { text: "While you ride or are carried, V looks down from above, then from high up over the rooftops." },
      { text: "This card: what is new since you were last here. It is in the Tab menu too." },
    ],
  },
  {
    version: "0.2.44", date: "2026-11-23", title: "A house of your own, food, and games with animals",
    items: [
      { text: "Make a house your own: your name over the door, your choice of furniture, your prizes on show." },
      { text: "Five hearts and a lunch box. Animals, trees and real shops give food; a good mix fills your hearts." },
      { text: "Cook in your own kitchen, and give food to a friend." },
      { text: "Teach your companion tricks, feed hungry wild animals, raise a chick, a lamb, a piglet or a calf in your garden, and run an agility course." },
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
      { text: "A second look for the whole world: flat bright colour and bold black lines. Switch it in the Tab menu." },
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
