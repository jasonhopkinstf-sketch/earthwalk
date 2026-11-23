// The local player: walking and flying, seen through their own eyes, over their shoulder or from behind;
// driving, seen from behind the car; and the view from above while riding, being carried, or being flown
// to a place (flight.js).

import * as THREE from "three";
import { stepCar } from "./cardrive.js";

const EYE_HEIGHT = 1.6;
const WALK = 4.5;
const RUN = 11;
const FLY = 40;
const FLY_FAST = 200;
const GRAVITY = 22;
const JUMP = 7;
const BODY_RADIUS = 0.45;
const LOOK = 0.0022; // radians per pixel of mouse movement
const RIDING_EYE = 0.85; // eyes above the seat
/** A car is wider than a walker, and its bumper is lower than a chest. */
const CAR_RADIUS = 1.25;
const CAR_BUMPER = 0.6;
/** What a car keeps of its speed when it meets a wall: a bump, never a crash. */
const BUMP_KEEPS = 0.5;
/**
 * The views while riding (the V key): the seat, then from above, then from high up. `far` is how far off the
 * camera hovers in metres, and `tilt` how steeply it looks down (radians above level).
 */
export const VIEWS = [
  { name: "your seat" },
  { name: "from above", far: 17, tilt: 0.5 },
  { name: "from high up", far: 62, tilt: 0.85 },
];
/**
 * The views on foot (the V key), as in the Windows game (AEarthWalkCharacter::ApplyView): through your own eyes,
 * over your shoulder, and from behind. `arm` is how far behind the camera hangs, in metres, and `least` and
 * `most` how near and far the mouse wheel may bring it; `right` and `up` set it off to one side and above.
 * The arm hangs from 30 cm above the eyes.
 */
export const FOOT_VIEWS = [
  { name: "your own eyes" },
  { name: "over your shoulder", arm: 2.5, least: 1.2, most: 5, right: 0.45, up: 0.4 },
  { name: "from behind", arm: 7, least: 4, most: 25, right: 0, up: 0.8 },
];
/** Seen from outside, looking no further down than this or up than that (radians): further would put the camera in the ground. */
const BEHIND_DOWN = -70 * Math.PI / 180;
const BEHIND_UP = 60 * Math.PI / 180;
/** How far the camera keeps from a wall or a ceiling. */
const CAMERA_CLEAR = 0.3;
/** Being carried, the hovering camera circles slowly until the mouse says where to look: radians a second. */
const DRIFT = 0.09;
/** The least turn from one angle to another, -pi to pi. */
const wrap = (a) => ((a % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;

export class Player {
  constructor(camera, world, canvas) {
    this.camera = camera;
    this.world = world;
    this.position = new THREE.Vector3(); // feet
    this.yaw = 0; // compass heading in radians: 0 north, clockwise
    this.pitch = 0;
    this.velocityY = 0;
    this.flying = false;
    this.grounded = false;
    this.waitingForGround = true;
    this.typing = false; // set while the chat box has focus
    this.keys = new Set();
    /** What the player is riding and steering (riding.js): { speed, seat, afloat }. `position` is then the seat, not the feet. */
    this.mount = null;
    /** True while something else moves the player: a train, or the friend steering what they both ride. */
    this.carried = false;
    /** Set while the player is being flown to a place (flight.js), which then says where they are each frame. */
    this.flight = null;
    /** How many times the player has looked round for themselves, by the mouse or the arrow keys. */
    this.looks = 0;
    /** Metres ridden on the present mount, for its legs. */
    this.travelled = 0;
    /**
     * Set while driving something with an engine (riding.js): which way it points and how it is moving.
     * { heading, vx, vz, speed, steer, turn, look, idle, view }. The camera then follows behind it.
     */
    this.car = null;
    /** Which of VIEWS the ride is seen from. */
    this.view = 0;
    /** Which of FOOT_VIEWS the player is seen from on foot, and how long each view's arm has been made by the mouse wheel. */
    this.foot = 0;
    this.footArm = FOOT_VIEWS.map((v) => v.arm ?? 0);
    this.armNow = 0; // how far behind the camera is this moment
    /** True while the camera stands back from the player on foot, far enough for their own figure to be drawn. */
    this.seenFromOutside = false;
    /** How fast the player is going over the ground, in metres a second: for their own figure's legs. */
    this.pace = 0;
    /** More that the camera must keep out of, beside the world's walls: the ceilings of the house the player is in (main.js gives them). */
    this.roofs = null;
    /** True while something else is taking the player along: a train, a friend, or a mount finding its own way. */
    this.taken = false;
    this.course = 0; // which way the ride has been going, as a heading
    this.orbit = 0; // how far round from behind the hovering camera has been swung
    this.zoom = 1; // nearer or further, by the mouse wheel
    this.drift = false; // circling by itself
    this.boom = null; // from the rider to the hovering camera
    this.was = new THREE.Vector3();
    this.still = 0;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    camera.rotation.order = "YXZ";

    addEventListener("keydown", (e) => {
      if (this.typing || e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
      if (e.code === "KeyF" && !e.repeat) { if (this.flight) this.flight.takeOver(); else this.setFlying(!this.flying); }
      if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    });
    addEventListener("keyup", (e) => this.keys.delete(e.code));
    addEventListener("blur", () => this.keys.clear());

    // Click to capture the mouse; dragging also looks around where capture is unavailable.
    let dragging = false;
    canvas.addEventListener("click", () => canvas.requestPointerLock?.()?.catch?.(() => undefined));
    canvas.addEventListener("mousedown", () => { dragging = true; });
    addEventListener("mouseup", () => { dragging = false; });
    addEventListener("mousemove", (e) => {
      if (document.pointerLockElement !== canvas && !dragging) return;
      this.look(e.movementX, e.movementY);
    });
    // From above, the wheel brings the camera nearer or takes it further off.
    canvas.addEventListener("wheel", (e) => {
      const foot = this.onFoot ? FOOT_VIEWS[this.foot] : null;
      if (!this.view && !foot?.arm) return;
      e.preventDefault();
      if (this.view) this.zoom = Math.min(2.5, Math.max(0.4, this.zoom * Math.exp(e.deltaY * 0.0012)));
      else this.footArm[this.foot] = Math.min(foot.most, Math.max(foot.least, this.footArm[this.foot] * Math.exp(e.deltaY * 0.0012)));
    }, { passive: false });
  }

  look(dx, dy) {
    // At the wheel the mouse looks round the car, and the car goes where it is steered.
    this.looks++;
    this.turn(dx * LOOK);
    this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch - dy * LOOK));
  }

  /** Looks further round to the right, by the mouse or the arrow keys. */
  turn(by) {
    if (!by) return;
    this.drift = false;
    // At the wheel it looks round the car, and the car goes where it is steered. Taken along and seen from above,
    // it swings the camera round the ride. Otherwise it turns the player.
    if (this.car) { this.car.look += by; this.car.idle = 0; } else if (this.view && this.taken) this.orbit += by; else this.yaw += by;
  }

  /** On their own feet (or flying by themselves): not riding, carried or being flown somewhere. */
  get onFoot() {
    return !this.mount && !this.carried && !this.flight;
  }

  /**
   * The V key: the next of VIEWS while riding, being carried or being flown, and the next of FOOT_VIEWS on foot.
   * Returns the view's name.
   */
  nextView() {
    if (this.onFoot) {
      this.foot = (this.foot + 1) % FOOT_VIEWS.length;
      return FOOT_VIEWS[this.foot].name;
    }
    this.setView((this.view + 1) % VIEWS.length);
    return VIEWS[this.view].name;
  }

  /** Goes straight to one of FOOT_VIEWS. */
  setFootView(foot) {
    this.foot = Math.min(FOOT_VIEWS.length - 1, Math.max(0, foot | 0));
  }

  setView(view) {
    this.view = view;
    this.pitch = 0;
    this.orbit = 0;
    this.zoom = 1;
    this.drift = view > 0;
    this.boom = null;
    if (this.car) this.car.look = 0;
    if (this.still > 0.5) this.course = this.car ? this.car.heading : this.yaw;
  }

  setFlying(fly) {
    if (this.mount || this.carried || this.flight) return; // not while riding, and a flight is flying already
    this.flying = fly;
    this.velocityY = 0;
    this.grounded = false;
  }

  /** Moves the player (and the world's origin) to a place on Earth. */
  travelTo(lat, lon) {
    this.world.setOrigin(lat, lon);
    this.position.set(0, this.position.y, 0);
    this.velocityY = 0;
    this.waitingForGround = true;
  }

  /** The first thing a camera must not go behind along a ray: a wall, a bridge, or a ceiling of the house the player is in. Null for nothing. */
  cameraHit(origin, direction, far) {
    const more = this.roofs?.() ?? [];
    const things = more.length ? this.world.solids.concat(more) : this.world.solids;
    this.ray.set(origin, direction);
    this.ray.near = 0;
    this.ray.far = far;
    let nearest = this.ray.intersectObjects(things, false)[0]?.distance ?? Infinity;
    // And from the far end back again. A ray only meets the face of a thing, not its back: so the underside of a roof
    // with no walls under it (a canopy, a veranda) lets the first one through, and the camera would sit on top of
    // it looking at tiles. Coming back, that roof is met face on.
    this.ray.set(origin.clone().addScaledVector(direction, far), direction.clone().negate());
    this.ray.firstHitOnly = false;
    for (const met of this.ray.intersectObjects(things, false)) nearest = Math.min(nearest, far - met.distance);
    this.ray.firstHitOnly = true;
    return nearest < Infinity ? { distance: Math.max(0, nearest) } : null;
  }

  /** First building surface along a ray, or null. */
  hit(origin, direction, far) {
    this.ray.set(origin, direction);
    this.ray.near = 0;
    this.ray.far = far;
    return this.ray.intersectObjects(this.world.solids, false)[0] ?? null;
  }

  /** Moves horizontally, sliding along building walls instead of passing through them. `radius` is how wide the mover is, `lift` how high above `position` it meets things. */
  moveHorizontally(move, radius = BODY_RADIUS, lift = 0.9) {
    const chest = this.position.clone().setY(this.position.y + lift);
    for (let attempt = 0; attempt < 2; attempt++) {
      const length = move.length();
      if (length < 1e-6) return;
      const direction = move.clone().divideScalar(length);
      const wall = this.hit(chest, direction, length + radius);
      if (!wall) {
        this.position.add(move);
        return;
      }
      const normal = wall.face.normal.clone().setY(0);
      if (normal.lengthSq() < 1e-6) return;
      normal.normalize();
      move.addScaledVector(normal, -move.dot(normal)); // keep only the part along the wall
    }
  }

  /**
   * One step of driving: the car's speed and heading move on (cardrive.js), and then the car itself does, as far
   * as the walls allow. `d` is how the vehicle handles (riding.js); `throttle` and `steer` are -1 to 1.
   */
  drive(car, d, seat, dt, throttle, steer, handbrake) {
    stepCar(car, d, dt, throttle, steer, handbrake);
    const want = new THREE.Vector3(car.vx * dt, 0, car.vz * dt);
    const before = this.position.clone();
    this.moveHorizontally(want.clone(), CAR_RADIUS, CAR_BUMPER - seat);
    const gotX = this.position.x - before.x, gotZ = this.position.z - before.z;
    if (dt > 0 && Math.hypot(gotX - want.x, gotZ - want.z) > 1e-4) { // a wall: slide along it, with less speed
      car.vx = (gotX / dt) * BUMP_KEEPS;
      car.vz = (gotZ / dt) * BUMP_KEEPS;
      car.speed = car.vx * Math.sin(car.heading) - car.vz * Math.cos(car.heading);
    }
  }

  /** The camera behind and above the car, swung round by the mouse and swinging back when the car moves on. */
  chase(dt) {
    const car = this.car;
    car.idle += dt;
    if (car.idle > 1.2 && Math.abs(car.speed) > 1.5) car.look *= Math.exp(-2.5 * dt);
    const want = car.heading + car.look;
    car.view += ((((want - car.view) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI) * (1 - Math.exp(-6 * dt));
    const back = 6.8 + Math.abs(car.speed) * 0.07;
    const up = Math.max(0.7, Math.min(9, 2.3 - this.pitch * 5));
    const eye = new THREE.Vector3(this.position.x, this.position.y + 0.9, this.position.z);
    const at = new THREE.Vector3(this.position.x - Math.sin(car.view) * back, this.position.y + up, this.position.z + Math.cos(car.view) * back);
    // Never behind a wall, and never under the ground.
    const reach = at.clone().sub(eye);
    const far = reach.length();
    const wall = this.cameraHit(eye, reach.clone().divideScalar(far), far + 0.4);
    if (wall) at.copy(eye).addScaledVector(reach, Math.max(0.15, (wall.distance - 0.4) / far));
    const ground = this.world.groundHeight(at.x, at.z);
    if (ground !== null && at.y < ground + 0.6 && !this.inTunnel()) at.y = ground + 0.6;
    this.camera.position.copy(at);
    this.camera.lookAt(this.position.x + Math.sin(car.heading) * 2, this.position.y + 0.7, this.position.z - Math.cos(car.heading) * 2);
  }

  /** Is the player under the ground, in a tunnel? (The cameras that keep above the ground must not, then.) */
  inTunnel() {
    return this.world.underGround(this.position.x, this.position.z, this.position.y - (this.mount ? this.mount.seat : 0));
  }

  /** Which way the ride is going, from where it was a frame ago. */
  track(dt) {
    const dx = this.position.x - this.was.x, dz = this.position.z - this.was.z;
    this.was.copy(this.position);
    const step = Math.hypot(dx, dz);
    if (dt > 0) this.pace = step < 50 ? step / dt : 0;
    if (dt > 0 && step < 50 && step / dt > 1) {
      this.still = 0;
      this.course += wrap(Math.atan2(dx, -dz) - this.course) * (1 - Math.exp(-2.5 * dt));
    } else this.still += dt;
  }

  /**
   * The camera hovering over the ride, looking down at it. Steering, it stays behind; taken along, it follows
   * the way the ride is going, circles slowly by itself, and goes where the mouse swings it.
   */
  hover(dt) {
    const v = VIEWS[this.view], car = this.car;
    let round;
    if (car) {
      car.idle += dt;
      if (this.taken) { if (this.drift) car.look += DRIFT * dt; }
      else if (car.idle > 1.2 && Math.abs(car.speed) > 1.5) car.look *= Math.exp(-2.5 * dt);
      round = car.view = car.heading + car.look;
    } else if (this.taken) {
      if (this.drift) this.orbit += DRIFT * dt;
      round = this.course + this.orbit;
    } else {
      this.orbit = 0;
      round = this.yaw;
    }
    const far = v.far * this.zoom;
    const tilt = Math.max(0.12, Math.min(1.45, v.tilt - this.pitch * 0.7));
    const eye = new THREE.Vector3(this.position.x, this.position.y + 0.6, this.position.z);
    const arm = (t) => new THREE.Vector3(-Math.sin(round) * Math.cos(t) * far, Math.sin(t) * far, Math.cos(round) * Math.cos(t) * far);
    // Over the rooftops, not behind them: where a building is in the way, look from steeper.
    let want = arm(tilt);
    for (let t = tilt; ; ) {
      const wall = this.cameraHit(eye, want.clone().divideScalar(far), far + 0.5);
      if (!wall) break;
      t += 0.2;
      if (t > 1.5) { want.multiplyScalar(Math.max(0.1, (wall.distance - 0.5) / far)); break; } // under a roof: come in close
      want = arm(t);
    }
    if (this.boom) this.boom.lerp(want, 1 - Math.exp(-5 * dt)); else this.boom = want;
    const at = eye.clone().add(this.boom);
    const ground = this.world.groundHeight(at.x, at.z);
    if (ground !== null && at.y < ground + 1.2 && !this.inTunnel()) at.y = ground + 1.2;
    this.camera.position.copy(at);
    this.camera.lookAt(eye);
  }

  /**
   * The camera behind the player on foot: over the shoulder, or further back. It looks where the player looks,
   * hangs on an arm from just above their head, and comes in along that arm rather than go behind a wall or
   * through a ceiling; it never goes under the ground.
   */
  behind(dt) {
    const v = FOOT_VIEWS[this.foot];
    this.pitch = Math.min(BEHIND_UP, Math.max(BEHIND_DOWN, this.pitch));
    const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw), cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    const forward = new THREE.Vector3(sin * cp, sp, -cos * cp);
    const right = new THREE.Vector3(cos, 0, sin);
    const up = new THREE.Vector3().crossVectors(right, forward);
    const hangs = new THREE.Vector3(this.position.x, this.position.y + EYE_HEIGHT + 0.3, this.position.z);
    const reach = forward.clone().multiplyScalar(-this.footArm[this.foot]).addScaledVector(right, v.right).addScaledVector(up, v.up);
    const far = reach.length();
    reach.divideScalar(far);
    // In at once when something is in the way, and out again gently when it no longer is.
    const wall = this.cameraHit(hangs, reach, far + CAMERA_CLEAR);
    const room = wall ? Math.max(0.05, wall.distance - CAMERA_CLEAR) : far;
    this.armNow = room < this.armNow ? room : Math.min(room, this.armNow + (room - this.armNow) * (1 - Math.exp(-10 * dt)) + 0.001);
    const at = hangs.addScaledVector(reach, this.armNow);
    const ground = this.world.groundHeight(at.x, at.z);
    if (ground !== null && at.y < ground + CAMERA_CLEAR && at.y > ground - 3 && !this.roofs?.().length && !this.inTunnel()) at.y = ground + CAMERA_CLEAR;
    this.camera.position.copy(at);
    this.camera.rotation.set(this.pitch, -this.yaw, 0);
    // Come right in against a wall, the camera is inside the player's own head: their figure is then left out.
    this.seenFromOutside = this.armNow > 0.9;
  }

  update(dt) {
    const k = this.keys;
    const turn = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
    const tilt = (k.has("ArrowUp") ? 1 : 0) - (k.has("ArrowDown") ? 1 : 0);
    if (!this.typing) {
      if (turn || tilt) this.looks++;
      this.turn(turn * 1.8 * dt);
      this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch + tilt * 1.2 * dt));
    }

    if (this.flight) {
      // Nothing to do: flight.js has put us where the flight has got to.
      this.taken = true;
    } else if (this.waitingForGround) {
      const ground = this.world.groundHeight(this.position.x, this.position.z);
      if (ground !== null) {
        this.position.y = ground;
        this.velocityY = 0;
        this.grounded = !this.flying;
        this.waitingForGround = false;
      }
    } else {
      const forward = this.typing ? 0 : (k.has("KeyW") ? 1 : 0) - (k.has("KeyS") ? 1 : 0);
      const strafe = this.typing ? 0 : (k.has("KeyD") ? 1 : 0) - (k.has("KeyA") ? 1 : 0);
      const fast = k.has("ShiftLeft") || k.has("ShiftRight");
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      const move = new THREE.Vector3();
      this.taken = this.carried || (!!this.mount && !forward && !strafe && !!this.autopilot);

      if (this.carried) {
        // Nothing to do: riding.js puts us where the train, or our friend, has got to.
      } else if (this.mount) {
        const m = this.mount;
        const car = this.car;
        // Being taken somewhere (orders.js): the mount finds its own way until the rider steers.
        const auto = !forward && !strafe ? this.autopilot : null;
        const from = this.position.clone();
        if (car && !auto) {
          // At the wheel: W and S are the pedals, A and D the steering, Space the handbrake.
          this.drive(car, m.drive, m.seat, dt, forward, strafe, !this.typing && k.has("Space"));
        } else {
          move.set(sin * forward + cos * strafe, 0, -cos * forward + sin * strafe);
          if (move.lengthSq() > 1) move.normalize();
          if (auto) move.set(auto.dx, 0, auto.dz);
          this.moveHorizontally(move.multiplyScalar(m.speed * (auto ? auto.pace : fast ? 1 : 0.55) * dt));
        }
        // A boat keeps to the water, and everything else keeps off it.
        const wet = this.world.waterAt(this.position.x, this.position.z);
        const feet = from.y - m.seat;
        let ground = this.world.floorAt(this.position.x, this.position.z, feet);
        // On a bridge the water is under the wheels, not round them. (And a boat does not sail up on to one.)
        const land = this.world.groundHeight(this.position.x, this.position.z);
        const onDeck = ground !== null && land !== null && ground > land + 0.4;
        if (m.afloat && onDeck) ground = land;
        // (Being driven along a road, a bridge is a bridge, whatever lies under it.)
        if (ground === null || (!auto && !(onDeck && !m.afloat) && wet !== null && wet !== !!m.afloat)) {
          this.position.copy(from);
          ground = this.world.floorAt(from.x, from.z, feet) ?? feet;
          if (car) car.vx = car.vz = car.speed = 0; // the water's edge, or the edge of the world so far
        }
        if (car && auto) {
          // Driven by somebody else's hands: it points where it is taken (orders.js turns us that way).
          car.heading = this.yaw;
          car.vx = dt > 0 ? (this.position.x - from.x) / dt : 0;
          car.vz = dt > 0 ? (this.position.z - from.z) / dt : 0;
          car.speed = Math.hypot(car.vx, car.vz);
          car.steer = car.turn = 0;
        }
        if (car) this.yaw = car.heading; // what friends are told, and which way the car is drawn
        this.travelled += Math.hypot(this.position.x - from.x, this.position.z - from.z);
        this.position.y = ground + m.seat;
        this.velocityY = 0;
        this.grounded = true;
      } else if (this.flying) {
        const speed = (fast ? FLY_FAST : FLY) * dt;
        const cp = Math.cos(this.pitch);
        move.set(sin * cp * forward + cos * strafe, 0, -cos * cp * forward + sin * strafe).multiplyScalar(speed);
        const rise = (this.typing ? 0 : (k.has("Space") ? 1 : 0) - (k.has("KeyC") ? 1 : 0)) + Math.sin(this.pitch) * forward;
        this.moveHorizontally(move);
        this.position.y += rise * speed;
        const ground = this.world.groundHeight(this.position.x, this.position.z);
        if (ground !== null && this.position.y < ground) this.position.y = ground;
      } else {
        const speed = (fast ? RUN : WALK) * (this.boost ?? 1) * (this.pep ?? 1) * dt; // whoever is "it" at tag is a little quicker (play.js), and so is anyone with five full hearts (lunch.js)
        move.set(sin * forward + cos * strafe, 0, -cos * forward + sin * strafe);
        if (move.lengthSq() > 1) move.normalize();
        this.moveHorizontally(move.multiplyScalar(speed));

        const ground = this.world.floorAt(this.position.x, this.position.z, this.position.y);
        if (ground === null) {
          this.waitingForGround = true; // walked into a part of the world that has not arrived yet
        } else {
          // Roofs count as floor when they are just under the feet.
          let floor = ground;
          const reach = 1.2 + Math.max(0.5, -this.velocityY * dt + 0.2);
          const roof = this.hit(this.position.clone().setY(this.position.y + 1.2), new THREE.Vector3(0, -1, 0), reach);
          if (roof && roof.point.y > floor) floor = roof.point.y;

          if (this.grounded && !this.typing && k.has("Space")) {
            this.velocityY = JUMP;
            this.grounded = false;
          }
          if (this.grounded && this.position.y - floor < 0.7) {
            this.position.y = floor; // follow slopes and small drops without bouncing
          } else {
            this.grounded = false;
            this.velocityY -= GRAVITY * dt;
            this.position.y += this.velocityY * dt;
            if (this.position.y <= floor) {
              this.position.y = floor;
              this.velocityY = 0;
              this.grounded = true;
            }
          }
        }
      }
    }

    this.track(dt);
    if (this.view && !this.mount && !this.carried && !this.flight) this.setView(0); // on foot again
    if (this.view && !this.waitingForGround) return this.hover(dt);
    if (this.car && this.mount && !this.waitingForGround) return this.chase(dt);
    if (this.foot && this.onFoot && !this.waitingForGround) return this.behind(dt);
    this.seenFromOutside = false;
    this.armNow = 0;
    this.camera.position.set(this.position.x, this.position.y + (this.mount || this.carried ? RIDING_EYE : EYE_HEIGHT), this.position.z);
    this.camera.rotation.set(this.pitch, -this.yaw, 0);
  }

  /** Compass heading in degrees, 0-360. */
  get heading() {
    return (((this.yaw * 180) / Math.PI) % 360 + 360) % 360;
  }
}
