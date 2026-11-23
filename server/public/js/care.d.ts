export const WANTS: Record<string, string[]>;
export const HUNGRY_ONE_IN: number;
export function dayOf(nowMs: number, tzMinutes?: number): number;
export function hungerOf(sp: string, thing: number, day: number): string | null;
