// Types for lookdata.js, so the server's tests can check the looks' numbers against the Windows game's.
export const LOOKS: string[];
export const FLAT_GROUND: Record<number, number>;
export const FLAT: Record<
  "vivid" | "level0" | "level1" | "level2" | "band1" | "band2" | "inkWidth" | "inkStrength" | "inkFar" | "farWidth" | "depthEdge" | "paintEdge" | "paintInk" | "fadeStart" | "fadeEnd" | "cloudInk",
  number
>;
export const SKY: Record<"bright" | "cloudBright" | "clouds" | "cloudInk" | "drift" | "sunSize", number>;
export function parseLook(text: unknown): { name: string; lines: boolean | undefined } | null;
export function lookSaid(name: string, lines: boolean): string;
export function vivid(rgb: number[], amount?: number): number[];
export function flatLevels(): number[];
