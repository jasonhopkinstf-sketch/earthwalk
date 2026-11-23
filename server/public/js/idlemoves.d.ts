export interface FidgetPose {
  lift: number; squash: number; spin: number; pitch: number; roll: number; twist: number; headPitch: number; headYaw: number; headRoll: number;
  armSwing: [number, number]; armOut: [number, number]; footSwing: [number, number]; footLift: [number, number]; tailYaw: number; tailUp: number;
}
export const IDLE_AFTER_S: number;
export const CYCLE_S: number;
export const SAY_FROM_S: number;
export const SAY_FOR_S: number;
export const FIDGETS: { id: string; seconds: number; pose(u: number, p: FidgetPose): void }[];
export const MUTTERS: string[];
export function noFidget(): FidgetPose;
export function seedOf(text: string): number;
export function idleAt(still: number, seed: number): { n: number; fidget: number; u: number | null; say: number | null } | null;
export function fidgetPose(fidget: number, u: number | null, p?: FidgetPose): FidgetPose;
