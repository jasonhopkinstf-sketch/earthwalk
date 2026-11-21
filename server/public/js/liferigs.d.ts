// Types for liferigs.js, so the server's tests can check every animal has a figure.
export type RigPart = [string, string | number, [number, number, number], [number, number, number], string?, number?];
export const RIGS: Record<string, { voice: string | null; alarm: string | null; alert: number; flee: number; stride: number; coats: [number, number][]; parts: RigPart[] }>;
