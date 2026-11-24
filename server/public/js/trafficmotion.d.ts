// Types for trafficmotion.js, so the server's tests can check the rule the browser runs.
export interface TripInput { id: number; w: number; left: boolean; da: number; db: number; path: number[]; lift?: number[] | null }
export interface PreparedTrip extends TripInput { n: number; dist: Float64Array; time: number; length: number; period: number }
export interface CarPose { x: number; y: number; yaw: number; moving: boolean; leg: number; pace: number; inLane: boolean; lift: number; rolled: number }
export const KERB_IN: number;
export const EASE_M: number;
export const TURN_M: number;
export interface TrainPose { along: number; back: boolean; moving: boolean; leg: number; stood: number }
export const THROUGH_DWELL_S: number;
export const JOIN_M: number;
export function runPose(train: PreparedTrip, since: number, back: boolean): { along: number; moving: boolean; done: boolean };
export function joinOf(train: PreparedTrip, far: boolean, others: PreparedTrip[]): { train: PreparedTrip; back: boolean } | null;
export function prepare(trip: TripInput): PreparedTrip;
export function pointAt(trip: PreparedTrip, d: number): [number, number];
export function liftAt(trip: PreparedTrip, d: number): number;
export function headingAt(trip: PreparedTrip, d: number, reach?: number): number;
export function stopsAlong(train: PreparedTrip): number[];
export function trainPose(train: PreparedTrip, t: number): TrainPose;
export function tripPose(trip: PreparedTrip, t: number): CarPose;
