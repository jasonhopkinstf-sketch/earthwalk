// Types for trafficmotion.js, so the server's tests can check the rule the browser runs.
export interface TripInput { id: number; w: number; left: boolean; da: number; db: number; path: number[]; lift?: number[] | null }
export interface PreparedTrip extends TripInput { n: number; dist: Float64Array; time: number; length: number; period: number }
export interface CarPose { x: number; y: number; yaw: number; moving: boolean; leg: number; pace: number; inLane: boolean; lift: number; rolled: number; out: boolean }
export interface KerbSpot { x: number; y: number; key: string }
export interface CarState { lag: number; rate?: number; tuck?: number; blocked?: boolean; byCar?: boolean; stuck?: number; ghost?: number }
export interface CarBox { x: number; y: number; fx: number; fy: number }
export interface GivingCar { trip: PreparedTrip; st: CarState; pose?: CarPose; box?: CarBox }
export const CAR_LONG: number;
export const CAR_WIDE: number;
export const KERB_GAP: number;
export const ABEAM_M: number;
export const SWERVE_M: number;
export const END_FREE_M: number;
export const AHEAD_S: number[];
export const FAR_S: number[];
export const STEER: number;
export const STUCK_S: number;
export const LAG_MOST_S: number;
export function alongOf(trip: PreparedTrip, x: number, y: number): { along: number; aside: number; d: number };
export function setSpots(trip: PreparedTrip, spots: KerbSpot[]): PreparedTrip;
export function restPose(trip: PreparedTrip, far: boolean): CarPose;
export function boxesMeet(a: CarBox, b: CarBox, long?: number, wide?: number): boolean;
export function giveWay(cars: GivingCar[], t: number, dt: number, how?: { gone?: (key: string) => boolean; also?: (car: GivingCar) => boolean }): void;
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
export function tripPose(trip: PreparedTrip, t: number, hold?: ((key: string) => number) | null, tuck?: number): CarPose;
