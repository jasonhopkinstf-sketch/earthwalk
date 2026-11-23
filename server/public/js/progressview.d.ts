interface Level { n: number; title: string; points: number; from: number; next: number; hint?: string }
export function fillOf(level: Level | null | undefined): number;
export function noteOf(news: { gained?: number; why?: string | null } | null | undefined): { points: string; text: string } | null;
export function levelUpOf(up: { n: number; title?: string; coins?: number; riddles?: number } | null | undefined): { title: string; name: string; text: string } | null;
export function tipOf(level: Level | null | undefined): string;
