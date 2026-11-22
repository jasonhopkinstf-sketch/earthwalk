// Treasure hunts. A hunt is a handful of clues, each a riddle about a real kind of place that the
// map knows near where the hunt begins: a church, a pond, a wood, a railway, a street by its name,
// a house by its number. Each is found by standing there; the treasure is at the last.
//
// A hunt is made from the map alone, for a square of the world about a kilometre across and a day,
// so everyone who starts one in the same neighbourhood on the same day gets the same hunt and
// friends can do it together. Nothing here knows about players (journal.ts keeps their place in a hunt).

import { hash32, latToY, lonToX, metersPerTile, xToLon, yToLat } from "./geo.ts";
import { DATA_Z, type Features, loadFeatures, type Pt } from "./osm.ts";
import { CHUNK_Z } from "./geo.ts";

/** One place to find: what it is, the riddle that points to it, where it is and how near counts as there. */
export interface HuntStop { kind: string; what: string; riddle: string; lat: number; lon: number; reach: number }

export const HUNT_STOPS = 5;
/** A hunt needs at least this many places to be worth setting out on. */
export const HUNT_MIN_STOPS = 3;
const HUNT_WAIT_MS = 10_000;

const RIDDLES: Record<string, string[]> = {
  church: ["People come to me to sing and to be quiet together, and I often wear a tower.", "I have a bell but no bicycle, and my doors are tallest on a holy day."],
  school: ["I am full of children by day and empty by night, and a bell tells everyone when to go home.", "Sums and stories live in me, and my playground is loudest at break."],
  barn: ["I keep the hay dry and the tractor out of the rain.", "I am a big house on a farm where nobody lives but animals and straw."],
  station: ["Trains stop at me to catch their breath, and people wait on me looking at clocks.", "I have platforms but I am no stage. Everybody here is going somewhere."],
  shop: ["You come to me with a list and leave with a bag.", "My shelves are full in the morning and people empty them all day."],
  greenhouse: ["My walls are windows, and tomatoes love me.", "I am a house made of glass where it is always summer."],
  windmill: ["I have arms but no hands, and I wave them at the wind.", "I grind and I turn, and the wind is my engine."],
  water: ["I am flat and wet, and I show you the sky upside down. The ducks know where I am.", "You can see your face in me, but you cannot walk on me. Stand at my edge."],
  wood: ["I am a crowd of trees standing close together.", "Step under my roof of leaves, where it is shady even at noon."],
  beach: ["I am made of a million tiny stones, and I am never far from water.", "Buckets and spades love me. Find where the sand is."],
  stream: ["I am water that is always going somewhere.", "I never stop running and I never get tired. Find my bank."],
  rails: ["I am two iron ribbons that run side by side and never meet. Stand beside me, never on me.", "Trains follow me wherever I go. Find where I pass."],
  meadow: ["Grass for breakfast, grass for tea: I am where the animals eat.", "I am a green table laid for cows and sheep."],
};
const WHAT: Record<string, string> = {
  church: "a place of worship", school: "a school", barn: "a barn", station: "a railway station", shop: "a shop", greenhouse: "a greenhouse", windmill: "a windmill",
  water: "the water's edge", wood: "a wood", beach: "a beach", stream: "a stream", rails: "the railway", meadow: "a meadow",
};
const BUILDING_KINDS: [RegExp, string][] = [
  [/^(church|chapel|cathedral|mosque|temple|synagogue|shrine|monastery)$/, "church"], [/^(school|kindergarten|university|college)$/, "school"],
  [/^(barn|farm_auxiliary|stable|cowshed|sty)$/, "barn"], [/^(train_station|station)$/, "station"], [/^(retail|supermarket|kiosk|shop)$/, "shop"],
  [/^(greenhouse|glasshouse)$/, "greenhouse"], [/^windmill$/, "windmill"],
];

interface Spot { key: string; kind: string; what: string; riddles: string[]; x: number; y: number; reach: number }

/** The neighbourhood a position belongs to: its centre, and a number for it. */
export function huntCell(lat: number, lon: number): { lat: number; lon: number; id: number } {
  const a = Math.round(lat * 100), b = Math.round(lon * 100);
  return { lat: a / 100, lon: b / 100, id: hash32(a, b) };
}

/** Everything in the features that a clue could point to, in world coordinates. `ox`, `oy` is where the hunt is centred. */
function spotsIn(features: Features[], ox: number, oy: number, S: number): Spot[] {
  const seen = new Set<string>();
  const out: Spot[] = [];
  const add = (key: string, kind: string, x: number, y: number, reach: number, what = WHAT[kind], riddles = RIDDLES[kind]): void => {
    if (seen.has(key) || !Number.isFinite(x) || !Number.isFinite(y)) return;
    seen.add(key);
    out.push({ key, kind, what, riddles, x, y, reach });
  };
  /** The corner of a shape nearest the centre of the hunt: somewhere on its edge that can be walked up to. */
  const nearest = (pts: Pt[]): Pt => pts.reduce((best, p) => (Math.hypot(p[0] - ox, p[1] - oy) < Math.hypot(best[0] - ox, best[1] - oy) ? p : best), pts[0]);
  const areaM2 = (ring: Pt[]): number => {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) a += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    return (Math.abs(a) / 2) * S * S;
  };
  for (const f of features) {
    for (const b of f.buildings) {
      if (b.ring.length < 3) continue;
      let cx = 0, cy = 0;
      for (const [x, y] of b.ring) { cx += x; cy += y; }
      cx /= b.ring.length;
      cy /= b.ring.length;
      const half = Math.max(...b.ring.map(([x, y]) => Math.hypot(x - cx, y - cy))) * S;
      const reach = Math.min(70, Math.max(25, half + 15));
      const kind = BUILDING_KINDS.find(([re]) => re.test(b.kind ?? ""))?.[1];
      if (kind) add(`b${b.id}`, kind, cx, cy, reach, b.kind === "mosque" || b.kind === "temple" || b.kind === "synagogue" || b.kind === "cathedral" || b.kind === "chapel" || b.kind === "church" ? `the ${b.kind}` : WHAT[kind]);
      else if (b.housenumber && b.street && /^\d{1,4}[a-zA-Z]?$/.test(b.housenumber) && b.street.length <= 40) {
        add(`n${b.street}/${b.housenumber}`, "number", cx, cy, Math.min(40, reach), `number ${b.housenumber}, ${b.street}`,
          [`Somebody lives at number ${b.housenumber}, ${b.street}. Find their front door.`, `Find the house that wears the number ${b.housenumber} on ${b.street}.`]);
      }
    }
    for (const a of f.areas) {
      const ring = a.rings[0];
      if (!ring || ring.length < 3) continue;
      const size = areaM2(ring);
      const [x, y] = nearest(ring);
      if (a.cls === "water" && !a.salt && size >= 150) add(`a${Math.abs(a.id)}`, "water", x, y, 30);
      else if (a.cls === "forest" && size >= 2000) add(`a${Math.abs(a.id)}`, "wood", x, y, 30);
      else if (a.cls === "sand" && size >= 300) add(`a${Math.abs(a.id)}`, "beach", x, y, 30);
    }
    for (const field of f.fields ?? []) {
      const ring = field.rings[0];
      if (!ring || ring.length < 3 || (field.kind !== "meadow" && field.kind !== "paddock") || areaM2(ring) < 1000) continue;
      const [x, y] = nearest(ring);
      add(`f${field.id}`, "meadow", x, y, 35);
    }
    for (const r of f.roads) {
      if (r.pts.length < 2) continue;
      const [x, y] = nearest(r.pts);
      if (r.cls === "stream") add(`s${r.id}`, "stream", x, y, 30);
      else if (r.cls === "rail") add(`r${r.id}`, "rails", x, y, 35);
      else if (r.cls === "road" && r.name && r.name.length <= 40 && !/^(motorway|trunk|motorway_link|trunk_link)$/.test(r.hw ?? "")) {
        add(`st${r.name}`, "street", x, y, 25, r.name, [`I am a street, and my name is ${r.name}. Come and stand on me.`, `Find the street called ${r.name}.`]);
      }
    }
  }
  return out.sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
}

/**
 * The hunt of a neighbourhood on a day: up to five places, each a short walk from the one before, of
 * as many different kinds as the map offers. Null where the map knows too little (open country, sea).
 */
export async function planHunt(lat: number, lon: number, day: number, load: (dx: number, dy: number) => Promise<Features> = loadFeatures): Promise<HuntStop[] | null> {
  const cell = huntCell(lat, lon);
  const ox = lonToX(cell.lon), oy = latToY(cell.lat);
  const S = metersPerTile(oy, CHUNK_Z);
  const shift = CHUNK_Z - DATA_Z;
  const dx0 = Math.floor(ox) >> shift, dy0 = Math.floor(oy) >> shift;
  const jobs: Promise<Features>[] = [];
  // A piece of map that is slow to come is done without: the hunt is made from what is at hand.
  const soon = (job: Promise<Features>): Promise<Features> => {
    let timer: NodeJS.Timeout;
    return Promise.race([job, new Promise<Features>((_, no) => { timer = setTimeout(() => no(new Error("slow")), HUNT_WAIT_MS); })]).finally(() => clearTimeout(timer));
  };
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) jobs.push(soon(load(dx0 + dx, dy0 + dy)));
  const features = (await Promise.allSettled(jobs)).flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
  const spots = spotsIn(features, ox, oy, S);
  const metres = (ax: number, ay: number, bx: number, by: number): number => Math.hypot(ax - bx, ay - by) * S;
  const seed = hash32(cell.id, day);

  const chosen: Spot[] = [];
  const kinds = new Map<string, number>();
  let cx = ox, cy = oy;
  for (let i = 0; i < HUNT_STOPS; i++) {
    const fits = (lo: number, hi: number, fresh: boolean): Spot[] => spots.filter((s) => {
      const d = metres(cx, cy, s.x, s.y);
      if (d < lo || d > hi || metres(ox, oy, s.x, s.y) > 950) return false;
      if (chosen.some((c) => c.key === s.key || metres(c.x, c.y, s.x, s.y) < 100)) return false;
      const had = kinds.get(s.kind) ?? 0;
      return fresh ? had === 0 : had < 2 && chosen[chosen.length - 1]?.kind !== s.kind;
    });
    const pool = [fits(120, 450, true), fits(80, 700, true), fits(120, 450, false), fits(80, 700, false)].find((p) => p.length) ?? [];
    if (!pool.length) break;
    // The kind is drawn first, so that a town's hundreds of house numbers do not crowd out its one church.
    const offered = [...new Set(pool.map((s) => s.kind))];
    const kind = offered[hash32(seed, i * 2) % offered.length];
    const of = pool.filter((s) => s.kind === kind);
    const pick = of[hash32(seed, i * 2 + 1) % of.length];
    chosen.push(pick);
    kinds.set(pick.kind, (kinds.get(pick.kind) ?? 0) + 1);
    cx = pick.x;
    cy = pick.y;
  }
  if (chosen.length < HUNT_MIN_STOPS) return null;
  return chosen.map((s, i) => ({
    kind: s.kind, what: s.what, riddle: s.riddles[hash32(seed, 100 + i) % s.riddles.length],
    lat: +yToLat(s.y).toFixed(6), lon: +xToLon(s.x).toFixed(6), reach: Math.round(s.reach),
  }));
}

const POINTS = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
/** Which way and roughly how far a place is from where someone stands: "about 250 metres to the north-east". */
export function wayTo(fromLat: number, fromLon: number, toLat: number, toLon: number): string {
  const north = (toLat - fromLat) * 111_320, east = (toLon - fromLon) * 111_320 * Math.cos((((fromLat + toLat) / 2) * Math.PI) / 180);
  const d = Math.hypot(north, east);
  const point = POINTS[Math.round((((Math.atan2(east, north) * 180) / Math.PI + 360) % 360) / 45) % 8];
  if (d < 40) return "very close by";
  if (d > 5000) return `a long way off to the ${point}, about ${Math.round(d / 1000)} km`;
  return `about ${d < 100 ? Math.round(d / 10) * 10 : Math.round(d / 50) * 50} metres to the ${point}`;
}
