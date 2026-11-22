// The garage: every player has a car of their own, which they can call to where they stand and
// drive off in. Its body and its paint are chosen in the passport; four plain paints and the car
// body are free, and the rest are bought with coins (daily.ts) and then theirs for good. The car
// is one of the prizes of the games on the journal (journal.ts).
//
// Only the choice is kept here. Where the car stands is the room's affair (rooms.ts), and how it
// drives is each game's (the browser's cardrive.js).

export interface CarPaint { id: string; name: string; hex: number; price: number }
export interface CarBody { id: string; name: string; price: number }

export const CAR_PAINTS: CarPaint[] = [
  { id: "red", name: "Post-box red", hex: 0xd94a3a, price: 0 },
  { id: "blue", name: "Sky blue", hex: 0x3f7fd0, price: 0 },
  { id: "yellow", name: "Buttercup", hex: 0xf2c94c, price: 0 },
  { id: "green", name: "Meadow green", hex: 0x4caf6a, price: 0 },
  { id: "white", name: "Cream", hex: 0xf4f1ea, price: 20 },
  { id: "silver", name: "Silver", hex: 0x9aa6b2, price: 20 },
  { id: "orange", name: "Marmalade", hex: 0xf08a3c, price: 20 },
  { id: "teal", name: "Teal", hex: 0x2f8f8a, price: 25 },
  { id: "purple", name: "Plum", hex: 0x7a4f9a, price: 25 },
  { id: "pink", name: "Bubblegum", hex: 0xe889b5, price: 30 },
  { id: "midnight", name: "Midnight", hex: 0x2f3b55, price: 30 },
  { id: "black", name: "Liquorice", hex: 0x26262b, price: 40 },
  { id: "gold", name: "Gold", hex: 0xe0b020, price: 120 },
];
/** The bodies a car can have. Each is one the games already know how to draw (VEHICLES in the browser's liferigs.js). */
export const CAR_BODIES: CarBody[] = [
  { id: "car", name: "Car", price: 0 },
  { id: "van", name: "Van", price: 80 },
];

/** What a player has chosen and bought. Free paints and bodies are everyone's and are not listed. */
export interface Garage { body: string; paint: string; paints: string[]; bodies: string[] }
export const emptyGarage = (): Garage => ({ body: "car", paint: "red", paints: [], bodies: [] });

export const paintById = (id: string): CarPaint | undefined => CAR_PAINTS.find((p) => p.id === id);
export const bodyById = (id: string): CarBody | undefined => CAR_BODIES.find((b) => b.id === id);

/** A car as it is told to the games: its body, and its paint as a colour. */
export function lookOf(g: Garage): { body: string; paint: number } {
  return { body: bodyById(g.body)?.id ?? "car", paint: (paintById(g.paint) ?? CAR_PAINTS[0]).hex };
}
