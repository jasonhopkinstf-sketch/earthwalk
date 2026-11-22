/** A car as it is driven: which way it points (radians, 0 north, clockwise), its velocity east and south, and its speed along its heading. */
export interface Car { heading: number; vx: number; vz: number; speed: number; steer: number; turn: number; look: number; idle: number; view: number }
/** How a vehicle handles. */
export interface Handling { top: number; reverse: number; pull: number; brake: number; base: number; grip: number }
export function newCar(heading: number): Car;
export function stepCar(car: Car, d: Handling, dt: number, throttle: number, steer: number, handbrake: boolean): void;
