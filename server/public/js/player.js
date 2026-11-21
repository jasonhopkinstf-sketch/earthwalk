// The local player: first-person walking and flying.

import * as THREE from "three";

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
    this.yaw += dx * LOOK;
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

  /** Moves horizontally, sliding along building walls instead of passing through them. */
  moveHorizontally(move) {
    const chest = this.position.clone().setY(this.position.y + 0.9);
    for (let attempt = 0; attempt < 2; attempt++) {
      const length = move.length();
      if (length < 1e-6) return;
      const direction = move.clone().divideScalar(length);
      const wall = this.hit(chest, direction, length + BODY_RADIUS);
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

  update(dt) {
    const k = this.keys;
    const turn = (k.has("ArrowRight") ? 1 : 0) - (k.has("ArrowLeft") ? 1 : 0);
    const tilt = (k.has("ArrowUp") ? 1 : 0) - (k.has("ArrowDown") ? 1 : 0);
    if (!this.typing) {
      this.yaw += turn * 1.8 * dt;
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
        move.set(sin * forward + cos * strafe, 0, -cos * forward + sin * strafe);
        if (move.lengthSq() > 1) move.normalize();
        const from = this.position.clone();
        this.moveHorizontally(move.multiplyScalar(m.speed * (fast ? 1 : 0.55) * dt));
        // A boat keeps to the water, and everything else keeps off it.
        const wet = this.world.waterAt(this.position.x, this.position.z);
        let ground = this.world.groundHeight(this.position.x, this.position.z);
        if (ground === null || (wet !== null && wet !== !!m.afloat)) {
          this.position.copy(from);
          ground = this.world.groundHeight(from.x, from.z) ?? from.y - m.seat;
        }
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
        const speed = (fast ? RUN : WALK) * dt;
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

    this.camera.position.set(this.position.x, this.position.y + (this.mount || this.carried ? RIDING_EYE : EYE_HEIGHT), this.position.z);
    this.camera.rotation.set(this.pitch, -this.yaw, 0);
  }

  /** Compass heading in degrees, 0-360. */
  get heading() {
    return (((this.yaw * 180) / Math.PI) % 360 + 360) % 360;
  }
}
