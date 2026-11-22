// Expeditions: the longer journeys a player sets out on from the passport. Unlike a favour, which a
// thing asks and which is over in a few minutes, an expedition is chosen, may span the world, and
// is kept until it is done. Three sorts:
// - an album: meet (talk to) enough of a family of things;
// - a tour: stand in enough of a list of famous places;
// - a journey home: an animal that is lost comes along as the player's companion until they reach
//   the part of the world it comes from. The reward is that kind of animal as a companion for good.
// Only what is done after setting out counts. Nothing can be failed, and one given up can be begun again.
//
// (The treasure hunt, also begun from the passport, is in hunt.ts.)

export interface Album { sort: "album"; id: string; title: string; blurb: string; kinds: string[]; need: number; coins: number }
export interface Tour { sort: "tour"; id: string; title: string; blurb: string; places: { name: string; lat: number; lon: number }[]; reachKm: number; need: number; coins: number }
export interface Homecoming { sort: "home"; id: string; title: string; blurb: string; passenger: string; where: string; home: (lat: number, lon: number) => boolean; coins: number }
export type Expedition = Album | Tour | Homecoming;

/** How many a player may be on at once (the treasure hunt apart). */
export const EXPEDITIONS_OPEN = 3;

export const EXPEDITIONS: Expedition[] = [
  { sort: "album", id: "farm", title: "The farmyard album", blurb: "Meet six kinds of farm animal, and say hello to each.", kinds: ["cow", "sheep", "horse", "chicken", "pig", "goat", "donkey", "goose"], need: 6, coins: 50 },
  { sort: "album", id: "minibeasts", title: "The minibeast album", blurb: "Meet five kinds of small creature. Look low, and among the flowers.", kinds: ["butterfly", "bee", "dragonfly", "ladybird", "ant", "grasshopper", "snail"], need: 5, coins: 50 },
  { sort: "album", id: "waterside", title: "The waterside album", blurb: "Meet five kinds of creature that live by the water.", kinds: ["duck", "swan", "heron", "frog", "otter", "beaver", "seagull", "crab", "seal", "flamingo"], need: 5, coins: 50 },
  { sort: "album", id: "safari", title: "The safari album", blurb: "Meet an elephant, a giraffe, a zebra and a lion. You will have to go where they live.", kinds: ["elephant", "giraffe", "zebra", "lion"], need: 4, coins: 70 },
  { sort: "album", id: "wheels", title: "The album of things that go", blurb: "Talk to a car, a tractor, a train, a taxi and a boat.", kinds: ["car", "tractor", "train", "taxi", "boat", "sailboat"], need: 5, coins: 50 },
  {
    sort: "tour", id: "wonders", title: "Wonders of the world", blurb: "Stand at seven of these twelve famous places.", reachKm: 1.5, need: 7, coins: 120,
    places: [
      { name: "the Eiffel Tower", lat: 48.8584, lon: 2.2945 }, { name: "the Colosseum", lat: 41.8902, lon: 12.4922 }, { name: "the Great Pyramid", lat: 29.9792, lon: 31.1342 },
      { name: "the Taj Mahal", lat: 27.1751, lon: 78.0421 }, { name: "the Great Wall at Badaling", lat: 40.3597, lon: 116.02 }, { name: "the Statue of Liberty", lat: 40.6892, lon: -74.0445 },
      { name: "the Sydney Opera House", lat: -33.8568, lon: 151.2153 }, { name: "Machu Picchu", lat: -13.1631, lon: -72.545 }, { name: "Big Ben", lat: 51.5007, lon: -0.1246 },
      { name: "the Golden Gate Bridge", lat: 37.8199, lon: -122.4783 }, { name: "Stonehenge", lat: 51.1789, lon: -1.8262 }, { name: "the Acropolis", lat: 37.9715, lon: 23.7267 },
    ],
  },
  {
    sort: "tour", id: "capitals", title: "Five capitals", blurb: "Visit the capital cities of five countries. Any five will do.", reachKm: 10, need: 5, coins: 90,
    places: [
      { name: "London", lat: 51.5074, lon: -0.1278 }, { name: "Paris", lat: 48.8566, lon: 2.3522 }, { name: "Berlin", lat: 52.52, lon: 13.405 }, { name: "Rome", lat: 41.9028, lon: 12.4964 },
      { name: "Madrid", lat: 40.4168, lon: -3.7038 }, { name: "Amsterdam", lat: 52.3676, lon: 4.9041 }, { name: "Dublin", lat: 53.3498, lon: -6.2603 }, { name: "Lisbon", lat: 38.7223, lon: -9.1393 },
      { name: "Athens", lat: 37.9838, lon: 23.7275 }, { name: "Oslo", lat: 59.9139, lon: 10.7522 }, { name: "Stockholm", lat: 59.3293, lon: 18.0686 }, { name: "Wellington", lat: -41.2866, lon: 174.7756 },
      { name: "Canberra", lat: -35.2809, lon: 149.13 }, { name: "Tokyo", lat: 35.6762, lon: 139.6503 }, { name: "Beijing", lat: 39.9042, lon: 116.4074 }, { name: "Seoul", lat: 37.5665, lon: 126.978 },
      { name: "Bangkok", lat: 13.7563, lon: 100.5018 }, { name: "New Delhi", lat: 28.6139, lon: 77.209 }, { name: "Cairo", lat: 30.0444, lon: 31.2357 }, { name: "Nairobi", lat: -1.2921, lon: 36.8219 },
      { name: "Pretoria", lat: -25.7479, lon: 28.2293 }, { name: "Washington", lat: 38.9072, lon: -77.0369 }, { name: "Ottawa", lat: 45.4215, lon: -75.6972 }, { name: "Mexico City", lat: 19.4326, lon: -99.1332 },
      { name: "Brasilia", lat: -15.7939, lon: -47.8828 }, { name: "Buenos Aires", lat: -34.6037, lon: -58.3816 },
    ],
  },
  {
    sort: "tour", id: "aotearoa", title: "Round New Zealand", blurb: "Stand in five of these eight places, from the far north to the fiords.", reachKm: 5, need: 5, coins: 90,
    places: [
      { name: "Cape Reinga", lat: -34.4265, lon: 172.6775 }, { name: "the Sky Tower in Auckland", lat: -36.8485, lon: 174.7622 }, { name: "Rotorua", lat: -38.1368, lon: 176.2497 },
      { name: "Wellington", lat: -41.2866, lon: 174.7756 }, { name: "Christchurch", lat: -43.5309, lon: 172.6365 }, { name: "Queenstown", lat: -45.0312, lon: 168.6626 },
      { name: "Milford Sound", lat: -44.6414, lon: 167.8974 }, { name: "Dunedin", lat: -45.8788, lon: 170.5028 },
    ],
  },
  { sort: "home", id: "penguin", title: "Take the lost penguin home", blurb: "A penguin has wandered far from the cold. Take it with you to the far south of the world.", passenger: "penguin", where: "the far south", home: (lat) => lat < -45, coins: 80 },
  { sort: "home", id: "camel", title: "Take the lost camel home", blurb: "A camel is missing the sand. Take it with you to the great deserts of north Africa or Arabia.", passenger: "camel", where: "the desert", home: (lat, lon) => lat > 14 && lat < 33 && lon > -16 && lon < 58, coins: 80 },
  { sort: "home", id: "kangaroo", title: "Take the lost kangaroo home", blurb: "A kangaroo has hopped too far. Take it with you to Australia.", passenger: "kangaroo", where: "Australia", home: (lat, lon) => lat > -39.5 && lat < -10.5 && lon > 113 && lon < 154, coins: 80 },
  { sort: "home", id: "panda", title: "Take the lost panda home", blurb: "A panda is dreaming of bamboo. Take it with you to China.", passenger: "panda", where: "China", home: (lat, lon) => lat > 21 && lat < 42 && lon > 98 && lon < 122, coins: 80 },
  { sort: "home", id: "reindeer", title: "Take the lost reindeer home", blurb: "A reindeer is too warm here. Take it with you to the far north, beyond the Arctic Circle.", passenger: "reindeer", where: "the far north", home: (lat) => lat > 66.5, coins: 80 },
  { sort: "home", id: "llama", title: "Take the lost llama home", blurb: "A llama misses the mountains. Take it with you to the Andes of South America.", passenger: "llama", where: "the Andes", home: (lat, lon) => lat > -36 && lat < 6 && lon > -81 && lon < -62, coins: 80 },
];
export const expeditionById = (id: string): Expedition | undefined => EXPEDITIONS.find((e) => e.id === id);

/** What an expedition asks for, as things to tick off; a journey home has just the one. */
export function itemsOf(e: Expedition): string[] {
  return e.sort === "album" ? e.kinds : e.sort === "tour" ? e.places.map((p) => p.name) : [e.where];
}
export const needOf = (e: Expedition): number => (e.sort === "home" ? 1 : e.need);
