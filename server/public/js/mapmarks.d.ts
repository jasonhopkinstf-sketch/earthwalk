// Types for mapmarks.js, so the server's tests can check the little map's arithmetic.
export type MapSize = 0 | 1 | 2;
export interface MarkKind { colour: string; words: string; wide: number; shape: "disc" | "square"; points: boolean; letter?: string }
export const SIDE: Record<1 | 2, number>;
export const SPAN: Record<1 | 2, number>;
export const EDGE: number;
export const LEGEND_H: number;
export const KINDS: Record<"friend" | "door" | "station" | "parked" | "mycar" | "taxi" | "goal" | "gate", MarkKind>;
export function nextSize(size: number): MapSize;
export function sizeName(size: number): "off" | "big" | "small";
export function sizeNamed(name: string | undefined): MapSize;
export function sizeSaid(size: number): string;
export function far(metres: number): string;
export function place(kind: string, dx: number, dz: number, side: number, span: number, point?: boolean):
  { on: true; x: number; y: number } | { on: false; x: number; y: number; ax: number; ay: number } | null;
export function goingWords(name: string, metres: number, size: number): string;
export function raceMarks(gates: number, mine: { gate: number; time: number | null } | null): { k: number; label: string }[];
