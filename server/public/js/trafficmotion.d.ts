// Types for trafficmotion.js, so the server's tests can check the rule the browser runs.
export interface TripInput { id: number; w: number; left: boolean; da: number; db: number; path: number[] }
export interface PreparedTrip extends TripInput { n: number; dist: Float64Array; time: number; length: number; period: number }
export interface CarPose { x: number; y: number; yaw: number; moving: boolean; leg: number; pace: number; inLane: boolean }
export const KERB_IN: number;
export const EASE_M: number;
export const TURN_M: number;
export function prepare(trip: TripInput): PreparedTrip;
export function tripPose(trip: PreparedTrip, t: number): CarPose;
