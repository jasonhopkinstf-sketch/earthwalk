// Types for lifemotion.js, so the server's tests can check the rule the browser runs.
export interface LifeHome { id: number; sp: string; n: number; r: number }
export interface CreatureState { id: number; x: number; y: number; yaw: number; moving: boolean; gait: number; pace: number; graze: boolean }
export const SPECIES: Record<string, { step: number; walk: number; pace: number; call: number }>;
export const HERD_STEPS: number;
export const CALL_SLOT: number;
export function hash32(a: number, b?: number): number;
export function memberId(homeId: number, k: number): number;
export function creatureAt(home: LifeHome, k: number, t: number): CreatureState;
export function callTime(id: number, sp: string, slot: number): number | null;
