// Types for peoplemotion.js, so the server's tests can check the rule the browser runs.
export const STROLL_PACE: number;
export const STROLL_WAIT: number;
export function strollAt(id: number, pts: number[], t: number): { x: number; z: number; fx: number; fz: number; moving: boolean };
