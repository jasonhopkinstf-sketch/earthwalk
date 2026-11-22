// How a car handles. Kept apart from the player (player.js), which knows about walls, water and
// the ground, so that the handling itself can be tried by the tests.
//
// A car has a heading and a velocity over the ground. The pedals change how fast it goes along its
// heading; the steering turns the heading, more gently the faster it goes. When the heading turns,
// a little of the speed is left going the old way: the tyres take that up at the rate of their
// grip, and with the handbrake on they hardly do, which is a slide.

/** A car standing still, pointing along `heading` (a compass heading in radians: 0 north, clockwise). */
export function newCar(heading) {
  return { heading, vx: 0, vz: 0, speed: 0, steer: 0, turn: 0, look: 0, idle: 9, view: heading };
}

/**
 * Moves a car's speed and heading on by `dt` seconds; where it goes is the caller's affair (`vx`, `vz`
 * are metres a second east and south). `d` is how it handles: `top` and `reverse` speeds (metres a
 * second), how hard it pulls and brakes (metres a second, each second), `base` (between its axles,
 * metres) and `grip`. `throttle` and `steer` are -1 to 1.
 */
export function stepCar(car, d, dt, throttle, steer, handbrake) {
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  let along = car.vx * sin - car.vz * cos; // forwards is (sin, -cos)
  let across = car.vx * cos + car.vz * sin;
  if (throttle > 0) along += (along < -0.5 ? d.brake : d.pull * Math.max(0, 1 - along / d.top)) * dt;
  else if (throttle < 0) along -= (along > 0.5 ? d.brake : d.pull * 0.7 * Math.max(0, 1 + along / d.reverse)) * dt;
  else along -= Math.sign(along) * Math.min(Math.abs(along), (1.4 + 0.012 * along * along) * dt); // rolling to a stop
  if (handbrake) along -= Math.sign(along) * Math.min(Math.abs(along), d.brake * 0.3 * dt);
  along = Math.max(-d.reverse, Math.min(d.top, along));
  across *= Math.exp(-(handbrake ? d.grip * 0.16 : d.grip) * dt);
  // The faster it goes, the less the wheels are turned, and they take a moment to turn.
  const lock = 0.62 / (1 + Math.abs(along) / 6 + (along / 16) ** 2);
  car.steer += (steer * lock - car.steer) * (1 - Math.exp(-7 * dt));
  car.turn = (along / d.base) * Math.tan(car.steer) * (handbrake ? 1.45 : 1);
  car.heading += car.turn * dt;
  car.vx = sin * along + cos * across;
  car.vz = -cos * along + sin * across;
  car.speed = along;
}
