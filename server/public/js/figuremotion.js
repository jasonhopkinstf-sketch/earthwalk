// How a player's animal moves its body: striding, hopping, standing about, jumping, flying and sitting
// on something. Numbers only; avatars.js turns them into the joints of a figure on screen, and the
// Windows game does the same sums in EarthAnimalFigure.cpp, so keep the two in step.
//
// A figure has a few joints. The whole of it leans and lifts about its hips; the body twists; the head
// nods and looks about on the neck; ears flop from where they join the head; arms swing from the
// shoulders and feet from the hips; the tail wags from its root. Angles are radians, lengths metres
// of the 1.4 m figure. A pose is what the joints are doing at one moment:
//
//   lift, pitch (forward), roll (to its right), squash (1 = its own height)        the whole figure
//   twist, breathe                                                                   the body
//   headPitch (down), headYaw (to its right), headRoll, blink (0 open, 1 shut)       the head
//   earBack, earTwitch                                                               the ears
//   armSwing[2] (forward), armOut[2] (raised sideways)                               left, right
//   footSwing[2] (forward), footLift[2], footSpread, footArc                         left, right
//     (a foot slides forward and back along the ground; footArc, 0 to 1, lets it swing up like a
//     pendulum instead, for sitting and flying)
//   tailYaw, tailUp

const TAU = Math.PI * 2;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A pose with everything at rest. */
export function restPose() {
  return {
    lift: 0, pitch: 0, roll: 0, squash: 1, twist: 0, breathe: 1,
    headPitch: 0, headYaw: 0, headRoll: 0, blink: 0, earBack: 0, earTwitch: 0,
    twitchSide: 0, armSwing: [0, 0], armOut: [0, 0], footSwing: [0, 0], footLift: [0, 0], footSpread: 0, footArc: 0,
    tailYaw: 0, tailUp: 0,
  };
}

/** What a figure remembers from one moment to the next. `seed` makes each one blink and look about in its own time. */
export function newFigureState(seed = 1) {
  return {
    rng: (Math.imul(seed | 0, 2654435761) >>> 0) || 1,
    time: 0, phase: 0, move: 0, run: 0, air: 0, fly: 0, seat: 0, turn: 0,
    blinkIn: 1.5, blinkLeft: 0, blinkAgain: false,
    lookIn: 2, look: 0, lookTo: 0, twitch: 0, twitchSide: 1,
    ear: 0, earSpeed: 0, bounce: 0, bounceSpeed: 0, wasInAir: false, lastLift: 0,
  };
}

/** The next number between 0 and 1 in this figure's own run of chances. */
function chance(s) {
  s.rng = (Math.imul(s.rng, 1664525) + 1013904223) >>> 0;
  return s.rng / 4294967296;
}

/**
 * Moves a figure on by `dt` seconds and fills in `pose`.
 * `m`: speed (metres a second over the ground), turn (radians a second, to its right), inAir (feet off
 * the ground), flying, seated (riding something), hopper (rabbits and frogs).
 */
export function stepFigure(s, dt, m, pose) {
  const ease = (from, to, rate) => from + (to - from) * (1 - Math.exp(-rate * dt));
  s.time += dt;
  const speed = m.seated ? 0 : m.speed;
  s.move = ease(s.move, clamp(speed / 2.5, 0, 1), 8); // 0 standing still, 1 walking briskly or faster
  s.run = ease(s.run, clamp((speed - 5.5) / 4.5, 0, 1), 6); // 0 walking, 1 flat out
  s.fly = ease(s.fly, m.flying ? 1 : 0, 5);
  s.seat = ease(s.seat, m.seated ? 1 : 0, 8);
  s.air = ease(s.air, m.inAir && !m.flying && !m.seated ? 1 : 0, 12);
  s.turn = ease(s.turn, clamp(m.turn, -4, 4), 6);
  const onFoot = (1 - s.fly) * (1 - s.seat);
  const stride = s.move * onFoot * (1 - s.air); // how much of the walk shows
  const still = (1 - s.move) * onFoot;

  // Longer strides at speed, so the feet do not blur: about two steps a second walking, three running.
  const strideLength = m.hopper ? 1.3 + 0.12 * speed : 0.9 + 0.22 * speed;
  s.phase = (s.phase + (dt * speed * TAU) / strideLength) % TAU;
  const sin = Math.sin(s.phase), cos = Math.cos(s.phase);

  // ---- on foot
  let lift = 0, squash = 1;
  let pitch = (0.06 * s.move + 0.2 * s.run) * onFoot;
  let roll = 0, twist = 0, headPitch = 0;
  let armL = 0, armR = 0, armOutL = 0.06, armOutR = 0.06;
  let footL = 0, footR = 0, liftL = 0, liftR = 0;
  let tailYaw = 0, tailUp = 0.45 * s.run;
  if (m.hopper) {
    // A hop: up and over for the first six tenths, then a crouch on the ground before the next.
    const u = s.phase / TAU;
    const up = u < 0.6 ? Math.sin((Math.PI * u) / 0.6) : 0;
    const crouch = u < 0.6 ? 0 : Math.sin((Math.PI * (u - 0.6)) / 0.4);
    lift = up * (0.2 + 0.12 * s.run) * stride;
    squash = 1 + (up * 0.1 - crouch * 0.16) * stride;
    footL = footR = (up > 0 ? -0.6 * up : 0.35 * crouch) * stride;
    armL = armR = (0.7 * up - 0.3 * crouch) * stride;
    pitch += 0.12 * up * stride;
    headPitch = (0.1 * crouch - 0.08 * up) * stride;
    tailUp += 0.3 * up * stride;
  } else {
    const reach = (0.55 + 0.35 * s.run) * stride;
    footL = sin * reach;
    footR = -sin * reach;
    // A foot comes off the ground while it swings forward.
    const step = (0.07 + 0.08 * s.run) * stride;
    liftL = Math.max(0, cos) * step;
    liftR = Math.max(0, -cos) * step;
    lift = (0.5 + 0.5 * Math.cos(2 * s.phase)) * (0.03 + 0.04 * s.run) * stride; // highest as one foot passes the other
    liftL -= lift; // the feet hang from the hips, and stay on the ground while the body bobs
    liftR -= lift;
    roll = sin * 0.05 * stride * (1 - s.run); // a waddle when walking
    twist = sin * 0.12 * stride;
    const swing = (0.6 + 0.5 * s.run) * stride;
    armL = -sin * swing;
    armR = sin * swing;
    armOutL = armOutR = 0.06 + 0.22 * s.run * stride;
    headPitch = Math.cos(2 * s.phase) * 0.03 * stride;
    tailYaw = -sin * 0.35 * stride;
  }
  roll += clamp(s.turn * 0.05, -0.2, 0.2) * s.move * onFoot; // leaning into a bend

  // ---- standing about: breathing, shifting weight, a wagging tail
  const breath = Math.sin(s.time * 2.1);
  lift += breath * 0.004 * still;
  roll += Math.sin(s.time * 0.63) * 0.02 * still;
  armOutL += breath * 0.02 * still;
  armOutR += breath * 0.02 * still;
  tailYaw += Math.sin(s.time * 3.1) * 0.3 * (1 - 0.7 * s.move) * (1 - s.fly);

  // ---- off the ground in a jump or a fall: arms up, one knee forward
  armOutL += 1.0 * s.air;
  armOutR += 1.0 * s.air;
  footL += 0.45 * s.air;
  footR -= 0.3 * s.air;
  liftL += 0.06 * s.air;
  tailUp += 0.3 * s.air;

  // A bounce on a spring when the feet come down: squashed, then back up.
  if (s.wasInAir && !m.inAir && !m.flying && !m.seated) s.bounceSpeed = -1.6;
  s.wasInAir = m.inAir;
  s.bounceSpeed += (-140 * s.bounce - 14 * s.bounceSpeed) * dt;
  s.bounce = clamp(s.bounce + s.bounceSpeed * dt, -0.25, 0.25);
  squash += s.bounce;

  // ---- flying: upright with arms out when hovering, stretched out forward at speed
  const forward = clamp(m.speed / 30, 0, 1) * s.fly;
  const hover = s.fly - forward;
  pitch += 1.2 * forward;
  roll += clamp(s.turn * 0.25, -0.5, 0.5) * s.fly;
  lift += Math.sin(s.time * 2.3) * 0.04 * hover;
  const flap = Math.sin(s.time * 7) * 0.07;
  armOutL += (1.3 + flap) * s.fly;
  armOutR += (1.3 + flap) * s.fly;
  footL += (Math.sin(s.time * 2.3 + 1) * 0.15 - 0.1) * hover - 0.55 * forward;
  footR += (Math.sin(s.time * 2.3 + 2.2) * 0.15 - 0.1) * hover - 0.7 * forward;
  tailUp += 0.5 * forward;
  headPitch -= 0.85 * forward; // looking where it is going, not at the ground

  // ---- sitting on something: down on the seat, feet forward and apart, hands out to hold on
  const jog = Math.sin(s.time * 9) * 0.012 * clamp(m.speed / 3, 0, 1);
  lift += (-0.1 + jog) * s.seat;
  pitch -= 0.05 * s.seat;
  footL += 1.15 * s.seat;
  footR += 1.15 * s.seat;
  armL += 0.75 * s.seat;
  armR += 0.75 * s.seat;
  armOutL += 0.15 * s.seat;
  armOutR += 0.15 * s.seat;

  // ---- the head: keeps level as the body leans, and looks about when nothing is happening
  s.lookIn -= dt;
  if (s.lookIn <= 0) {
    s.lookIn = 1.8 + 3.5 * chance(s);
    s.lookTo = chance(s) < 0.4 ? 0 : (chance(s) - 0.5) * 1.3;
    if (chance(s) < 0.5) {
      s.twitch = 1;
      s.twitchSide = chance(s) < 0.5 ? 0 : 1;
    }
  }
  const idle = Math.max(still, s.seat);
  s.look = ease(s.look, s.lookTo * idle, 3.5);
  s.twitch = Math.max(0, s.twitch - dt * 5);

  // Blinking: shut for an eighth of a second every few seconds, now and then twice.
  s.blinkIn -= dt;
  if (s.blinkIn <= 0 && s.blinkLeft <= 0) {
    s.blinkLeft = 0.13;
    s.blinkIn = s.blinkAgain ? 2 + 4 * chance(s) : chance(s) < 0.2 ? 0.28 : 2 + 4 * chance(s);
    s.blinkAgain = s.blinkIn < 1;
  }
  s.blinkLeft = Math.max(0, s.blinkLeft - dt);

  // Ears trail behind on a spring: back when running or flying, bouncing as the body rises and falls.
  const rise = dt > 0 ? (lift - s.lastLift) / dt : 0;
  s.lastLift = lift;
  const earRest = 0.35 * s.run * onFoot + 0.9 * forward + 0.25 * s.air;
  s.earSpeed += ((earRest - s.ear) * 90 - s.earSpeed * 9 + clamp(rise, -3, 3) * 14) * dt;
  s.ear = clamp(s.ear + s.earSpeed * dt, -0.5, 1.3);

  pose.lift = lift;
  pose.pitch = pitch;
  pose.roll = roll;
  pose.squash = squash;
  pose.twist = twist;
  pose.breathe = 1 + breath * 0.015 * still;
  pose.headPitch = headPitch - pitch * 0.6 * onFoot;
  pose.headYaw = s.look;
  pose.headRoll = s.look * 0.15;
  pose.blink = s.blinkLeft > 0 ? 1 : 0;
  pose.earBack = s.ear;
  pose.earTwitch = Math.sin(s.twitch * Math.PI) * 0.35;
  pose.twitchSide = s.twitchSide;
  pose.armSwing[0] = armL;
  pose.armSwing[1] = armR;
  pose.armOut[0] = armOutL;
  pose.armOut[1] = armOutR;
  pose.footSwing[0] = footL;
  pose.footSwing[1] = footR;
  pose.footLift[0] = liftL;
  pose.footLift[1] = liftR;
  pose.footSpread = 0.1 * s.seat;
  pose.footArc = Math.max(s.seat, s.fly, s.air);
  pose.tailYaw = tailYaw;
  pose.tailUp = tailUp;
  return pose;
}
