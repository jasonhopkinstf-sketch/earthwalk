// The local player: first-person walking and flying, and driving, seen from behind the car.

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
    /** Metres ridden on the present mount, for its legs. */
    this.travelled = 0;
    /**
     * Set while driving something with an engine (riding.js): which way it points and how it is moving.
     * { heading, vx, vz, speed, steer, turn, look, idle, view }. The camera then follows behind it.
     */
    this.car = null;
    this.ray = new THREE.Raycaster();
    this.ray.firstHitOnly = true;
    camera.rotation.order = "YXZ";

    addEventListener("keydown", (e) => {
      if (this.typing || e.ctrlKey || e.metaKey || e.altKey) return;
      this.keys.add(e.code);
      if (e.code === "KeyF" && !e.repeat) this.setFlying(!this.flying);
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
  }

  look(dx, dy) {
    // At the wheel the mouse looks round the car, and the car goes where it is steered.
    if (this.car) { this.car.look += dx * LOOK; this.car.idle = 0; } else this.yaw += dx * LOOK;
    this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch - dy * LOOK));
  }

  setFlying(fly) {
    if (this.mount || this.carried) return; // not while riding
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
    const wall = this.hit(eye, reach.clone().divideScalar(far), far + 0.4);
    if (wall) at.copy(eye).addScaledVector(reach, Math.max(0.15, (wall.distance - 0.4) / far));
    const ground = this.world.groundHeight(at.x, at.z);
    if (ground !== null && at.y < ground + 0.6) at.y = ground + 0.6;
    this.camera.position.copy(at);
    this.camera.lookAt(this.position.x + Math.sin(car.heading) * 2, this.position.y + 0.7, this.position.z - Math.cos(car.heading) * 2);
  }

  update(dt) {
    const k = this.keys;
    const turn = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
    const tilt = (k.has("ArrowUp") ? 1 : 0) - (k.has("ArrowDown") ? 1 : 0);
    if (!this.typing) {
      if (this.car) { this.car.look += turn * 1.8 * dt; if (turn) this.car.idle = 0; } else this.yaw += turn * 1.8 * dt;
      this.pitch = Math.min(1.5, Math.max(-1.5, this.pitch + tilt * 1.2 * dt));
    }

    if (this.waitingForGround) {
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
        let ground = this.world.groundHeight(this.position.x, this.position.z);
        // (Being driven along a road, a bridge is a bridge, whatever lies under it.)
        if (ground === null || (!auto && wet !== null && wet !== !!m.afloat)) {
          this.position.copy(from);
          ground = this.world.groundHeight(from.x, from.z) ?? from.y - m.seat;
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
        const speed = (fast ? RUN : WALK) * (this.boost ?? 1) * dt; // whoever is "it" at tag is a little quicker (play.js)
        move.set(sin * forward + cos * strafe, 0, -cos * forward + sin * strafe);
        if (move.lengthSq() > 1) move.normalize();
        this.moveHorizontally(move.multiplyScalar(speed));

        const ground = this.world.groundHeight(this.position.x, this.position.z);
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

    if (this.car && this.mount && !this.waitingForGround) return this.chase(dt);
    this.camera.position.set(this.position.x, this.position.y + (this.mount || this.carried ? RIDING_EYE : EYE_HEIGHT), this.position.z);
    this.camera.rotation.set(this.pitch, -this.yaw, 0);
  }

  /** Compass heading in degrees, 0-360. */
  get heading() {
    return (((this.yaw * 180) / Math.PI) % 360 + 360) % 360;
  }
}
