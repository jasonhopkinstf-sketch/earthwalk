// Things to show people: a short list of what the world can do, each with a real place where it is
// right there to be seen. A game lists them ("Show me..."), travels to the one chosen and stands the
// player beside the thing itself (the train's next stop, the nearest horse, a parked car).
//
// The places were picked by looking at what the generator makes there (a station with two trains, a
// farm with cows at the gate), and the server keeps them built, so that a show starts at once and not
// after a minute of "building the world here".

import { CHUNK_Z, latToY, lonToX } from "./geo.ts";
import { DATA_Z } from "./osm.ts";

export interface Show {
  id: string;
  /** What it is called in the list, and a line about what will be seen. */
  title: string;
  text: string;
  /** What to do on arriving, said once the player is standing there. */
  how: string;
  /**
   * What to stand the player beside: a train's next stop, the nearest home of one of the animals (or
   * machines) in `sp`, a parked car, a front door that opens, or nothing (`air`: up in the sky, flying).
   * `ride` means the thing is ridden, so the player is put within reach of the animal itself.
   */
  find: "train" | "home" | "car" | "door" | "air";
  sp?: string[];
  ride?: boolean;
  place: { name: string; lat: number; lon: number };
  /** How many chunks each way from the place to keep built (1 when absent). A train is met anywhere along its run. */
  keep?: number;
}

export const SHOWS: Show[] = [
  {
    id: "train", title: "Catch a train", text: "Trains run through Glen Eden, and stop at its station.",
    how: "When the train stops beside you, press E to hop on. E again hops off.",
    find: "train", place: { name: "Glen Eden station, Auckland", lat: -36.9109, lon: 174.6568 }, keep: 3,
  },
  {
    id: "farm", title: "Meet the farm animals", text: "Cows, sheep, goats and horses in the paddocks at Karaka.",
    how: "Walk up to an animal. Press T to talk to it, or E to ride it.",
    find: "home", sp: ["cow", "sheep", "goat", "pig", "chicken", "donkey", "goose"], place: { name: "Karaka, Auckland", lat: -37.105, lon: 174.88 },
  },
  {
    id: "horse", title: "Ride a horse", text: "A horse in its paddock, waiting for a rider.",
    how: "Press E beside the horse to hop on. W goes, Shift gallops, E hops off.",
    find: "home", sp: ["horse"], ride: true, place: { name: "Karaka, Auckland", lat: -37.10542, lon: 174.87881 },
  },
  {
    id: "car", title: "Drive a car", text: "Cars parked along the streets of Devonport.",
    how: "Press E beside the car to get in. W and S are the pedals, A and D steer, Space is the handbrake.",
    find: "car", place: { name: "Devonport, Auckland", lat: -36.831, lon: 174.796 },
  },
  {
    id: "house", title: "Walk into a house", text: "Front doors that open, with rooms inside.",
    how: "Press E at the door with the yellow COME IN sign. E again, just inside, comes back out.",
    find: "door", place: { name: "Devonport, Auckland", lat: -36.8312, lon: 174.7958 },
  },
  {
    id: "boat", title: "Sail a boat", text: "Sailing boats on the water at Westhaven Marina.",
    how: "Press E beside the boat to step aboard. W sails, A and D turn, E steps off.",
    find: "home", sp: ["sailboat", "boat"], ride: true, place: { name: "Westhaven Marina, Auckland", lat: -36.84062, lon: 174.74827 },
  },
  {
    id: "tractor", title: "Drive a tractor", text: "Tractors at work in the fields at Clevedon.",
    how: "Press E beside the tractor to climb on. W and S are the pedals, A and D steer.",
    find: "home", sp: ["tractor"], ride: true, place: { name: "Clevedon, Auckland", lat: -36.99205, lon: 175.03618 },
  },
  {
    id: "penguins", title: "Penguins on the beach", text: "Penguins, crabs and seagulls on the sand at Piha.",
    how: "Walk among them. Press T beside one to say hello.",
    find: "home", sp: ["penguin"], place: { name: "Piha beach, Auckland", lat: -36.95407, lon: 174.46811 },
  },
  {
    id: "camel", title: "Ride a camel at the Pyramids", text: "Camels on the sand at Giza, in Egypt.",
    how: "Press E beside the camel to climb on. W goes, Shift goes faster, E climbs off.",
    find: "home", sp: ["camel"], ride: true, place: { name: "The Pyramids of Giza, Egypt", lat: 29.97692, lon: 31.1322 },
  },
  {
    id: "safari", title: "Go on safari", text: "Elephants, giraffes, zebras and lions in Nairobi National Park.",
    how: "Walk up to them. E rides an elephant, a giraffe, a zebra or a lion, and T talks to it.",
    find: "home", sp: ["elephant", "giraffe", "zebra", "lion"], place: { name: "Nairobi National Park, Kenya", lat: -1.37329, lon: 36.85884 },
  },
  {
    id: "kangaroos", title: "Kangaroos and koalas", text: "Kangaroos on the grass, koalas in the trees by the lake, in Canberra.",
    how: "Walk up to a kangaroo and press E to ride it. T talks to it.",
    find: "home", sp: ["kangaroo"], place: { name: "Canberra, Australia", lat: -35.29894, lon: 149.09619 },
  },
  {
    id: "air", title: "See a city from the air", text: "Up over the middle of Auckland, flying.",
    how: "You are flying. W goes where you look, Shift goes fast, Space and C go up and down. F lands.",
    find: "air", place: { name: "The Sky Tower, Auckland", lat: -36.8485, lon: 174.7622 },
  },
];

/** The chunks to keep built for a show: the one the place is in, and those round it. */
export function chunksOf(show: Show, radius = show.keep ?? 1): [number, number][] {
  const cx = Math.floor(lonToX(show.place.lon)), cy = Math.floor(latToY(show.place.lat));
  const out: [number, number][] = [[cx, cy]];
  for (let j = -radius; j <= radius; j++) for (let i = -radius; i <= radius; i++) if (i || j) out.push([cx + i, cy + j]);
  return out;
}

/** The data tiles under everything a game asks for on arriving at a show (two chunks each way). */
export function tilesOf(show: Show): [number, number][] {
  const shift = CHUNK_Z - DATA_Z;
  const cx = Math.floor(lonToX(show.place.lon)), cy = Math.floor(latToY(show.place.lat));
  const out = new Map<string, [number, number]>();
  const r = (show.keep ?? 1) + 1;
  for (let j = -r; j <= r; j++) for (let i = -r; i <= r; i++) out.set(`${(cx + i) >> shift}/${(cy + j) >> shift}`, [(cx + i) >> shift, (cy + j) >> shift]);
  return [...out.values()];
}

/**
 * Keeps the shows built: goes through them one piece at a time, slowly, making whatever is not in
 * the cache. First the map under each show is downloaded (`warm`, one data tile at a time, quietly:
 * behind anything a player is waiting for, and with a rest after each download, because the map
 * servers allow only so much an hour and players come first). Then its chunks are built (`prepare`
 * does one, mesh and labels). It starts a while after the server does and goes round again every few
 * hours, since a full disk may have cleared pieces away. What fails is left for the next round.
 */
export function keepShowsBuilt(
  prepare: (x: number, y: number) => Promise<void>, warm: (dx: number, dy: number) => Promise<"there" | "fetched" | "failed">,
  { startMs = 20_000, pauseMs = 1500, restMs = 12_000, everyMs = 6 * 3600_000, shows = SHOWS, log = (line: string) => console.log(line) } = {},
): { stop: () => void; round: () => Promise<number> } {
  let stopped = false;
  const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms).unref(); });
  const round = async (): Promise<number> => {
    let failed = 0;
    for (const show of shows) {
      let mapped = true;
      for (const [dx, dy] of tilesOf(show)) {
        if (stopped) return failed;
        const how = await warm(dx, dy);
        if (how === "failed") mapped = false;
        if (how !== "there") await sleep(restMs);
      }
      if (!mapped) {
        // Without its map a chunk cannot be built without hurrying the download, which is for players to do.
        if (!failed++) log(`showcase: the map for "${show.title}" could not be downloaded just now; it is tried again later`);
        continue;
      }
      for (const [x, y] of chunksOf(show)) {
        if (stopped) return failed;
        await prepare(x, y).catch((err) => {
          if (!failed++) log(`showcase: could not build part of "${show.title}" (${err instanceof Error ? err.message : String(err)}); it is tried again later`);
        });
        await sleep(pauseMs);
      }
    }
    return failed;
  };
  const timer = setTimeout(function again() {
    void round().then((failed) => {
      if (stopped) return;
      log(failed ? `showcase: ${failed} pieces could not be built this time` : "showcase: every place to show is built");
      timer2 = setTimeout(again, failed ? 10 * 60_000 : everyMs);
      timer2.unref();
    });
  }, startMs);
  timer.unref();
  let timer2: NodeJS.Timeout | undefined;
  return { stop: () => { stopped = true; clearTimeout(timer); clearTimeout(timer2); }, round };
}
