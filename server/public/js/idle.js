// Left standing for half a minute, a player's animal fidgets and talks to itself (idlemoves.js has the
// moves and the words). The game is seen through my animal's eyes, so when it is mine that is idle the
// camera steps out in front to watch it; the first key, click or move of the mouse puts me straight back
// behind its eyes. Friends who stand about fidget too: nothing about it is sent, each game works it out from
// how long they have not moved.
//
// Nothing fidgets while a race or a game of tag or hide and seek is on (a hider must be able to keep still),
// or while a panel is open and being read.

import * as THREE from "three";
import { animateAnimal, makeAnimal, wearHat } from "./avatars.js";
import { makeHat } from "./hats.js";
import { fidgetPose, idleAt, MUTTERS, noFidget, seedOf } from "./idlemoves.js";
import { unlinedSprite } from "./look.js";

const LEG = 0.32; // from the hip down to the foot, as in avatars.js
/** While any of these is on screen I am busy, not idle. */
const PANELS = ["passport", "menu", "ask", "choice", "talkbox", "news", "show", "decor", "lunch", "train"];
/** While any of these is on screen a game is on, and nobody fidgets. */
const GAMES = ["race", "play", "playcount", "countdown", "blind", "lesson"];
/** How far in front of my animal the camera stands, the least room it needs, and how long it takes to step out. */
const CAMERA_M = 3.6, ROOM_M = 1.6, OUT_S = 1.3;
/** How far off a friend's muttering can be read. */
const READ_M = 35;
const glide = (x) => { const u = Math.min(1, Math.max(0, x)); return u * u * (3 - 2 * u); };

const bubbles = new Map();
/** A white speech bubble with a few words in it, painted once for each thing said. */
function bubble(text) {
  let made = bubbles.get(text);
  if (made) return made;
  const font = "600 34px system-ui, sans-serif";
  const canvas = document.createElement("canvas");
  const pen = canvas.getContext("2d");
  pen.font = font;
  // Two or three short lines read better over a small animal than one long one.
  const lines = [];
  for (const word of text.split(" ")) {
    const last = lines[lines.length - 1];
    if (last !== undefined && pen.measureText(`${last} ${word}`).width <= 400) lines[lines.length - 1] = `${last} ${word}`;
    else lines.push(word);
  }
  const wide = Math.max(...lines.map((l) => pen.measureText(l).width));
  canvas.width = Math.ceil(wide) + 56;
  canvas.height = lines.length * 42 + 56;
  const w = canvas.width, h = canvas.height - 22; // the tail hangs below
  pen.fillStyle = "#ffffff";
  pen.strokeStyle = "#26221f";
  pen.lineWidth = 4;
  pen.lineJoin = "round";
  pen.beginPath();
  pen.roundRect(3, 3, w - 6, h - 6, 22);
  pen.fill();
  pen.stroke();
  pen.beginPath();
  pen.moveTo(w / 2 - 16, h - 5);
  pen.lineTo(w / 2 - 4, canvas.height - 3);
  pen.lineTo(w / 2 + 14, h - 5);
  pen.fill();
  pen.stroke();
  pen.fillRect(w / 2 - 14, h - 9, 26, 6); // the join between the bubble and its tail
  pen.font = font;
  pen.fillStyle = "#26221f";
  pen.textAlign = "center";
  pen.textBaseline = "middle";
  lines.forEach((line, i) => pen.fillText(line, w / 2, 17 + 21 + i * 42));
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  made = { material: unlinedSprite(new THREE.SpriteMaterial({ map, sizeAttenuation: false, depthWrite: false, transparent: true })), aspect: canvas.width / canvas.height, lines: lines.length };
  bubbles.set(text, made);
  return made;
}

/** Puts what a fidget adds on a figure that animateAnimal has just posed. */
function addFidget(figure, p) {
  const r = figure.userData.rig;
  r.all.rotation.y = -p.spin; // to its right
  const tall = 1 + p.squash, wide = 1 / Math.sqrt(tall);
  r.all.scale.set(r.all.scale.x * wide, r.all.scale.y * tall, r.all.scale.z * wide);
  r.hips.position.y += p.lift;
  r.hips.rotation.x -= p.pitch;
  r.hips.rotation.z -= p.roll;
  r.trunk.rotation.y += p.twist;
  r.head.rotation.x -= p.headPitch;
  r.head.rotation.y -= p.headYaw;
  r.head.rotation.z -= p.headRoll;
  r.tail.rotation.x -= p.tailUp;
  r.tail.rotation.y += p.tailYaw;
  for (let i = 0; i < 2; i++) {
    const side = i === 0 ? -1 : 1;
    r.arms[i].rotation.x += p.armSwing[i];
    r.arms[i].rotation.z += side * p.armOut[i];
    r.feet[i].position.y += p.footLift[i];
    r.feet[i].position.z -= LEG * Math.sin(p.footSwing[i]);
    r.feet[i].rotation.x += p.footSwing[i] * 0.6;
  }
}

export class Idle {
  /**
   * @param {{ scene: THREE.Scene, camera: THREE.Camera, player: import("./player.js").Player, world: import("./world.js").World,
   *   meetup: import("./net.js").Meetup, avatars: import("./avatars.js").Avatars, nudge?: () => string | null | undefined }} parts
   *   `nudge` is something worth doing next (the progress bar's hint), for my animal to wonder aloud about.
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.still = 0; // seconds I have done nothing
    this.was = new THREE.Vector3();
    this.wasYaw = 0;
    this.wasPitch = 0;
    this.wasLooks = 0;
    this.own = null; // my own figure, while the camera is out watching it: { group, avatar, hat, hatMesh, bubble }
    this.shot = null; // where the camera stands to watch: { turn, far }, or false where there is no room
    this.out = 0; // how far out the camera has stepped, 0 to 1
    this.pose = noFidget();
    this.friends = new Map(); // peer id -> { still, lat, lon, yaw, seed, bubble, touched }
    this.elements = (ids) => ids.map((id) => document.getElementById(id)).filter(Boolean);
    this.panels = this.elements(PANELS);
    this.games = this.elements(GAMES);
    const wake = () => { this.still = 0; };
    for (const type of ["keydown", "pointerdown", "wheel", "mousemove"]) addEventListener(type, wake, { passive: true });
  }

  /** Is my own animal being watched fidgeting just now? */
  get active() {
    return !!this.own;
  }

  /** Every frame, after the player and the friends have been placed. */
  frame(dt) {
    const gameOn = this.games.some((e) => !e.hidden);
    this.watchFriends(dt, gameOn);
    const p = this.player;
    const moved = p.position.distanceToSquared(this.was) > 1e-4 || p.yaw !== this.wasYaw || p.pitch !== this.wasPitch || p.looks !== this.wasLooks;
    this.was.copy(p.position);
    this.wasYaw = p.yaw;
    this.wasPitch = p.pitch;
    this.wasLooks = p.looks;
    const busy = moved || gameOn || p.keys.size > 0 || p.typing || !!p.mount || p.carried || !!p.flight || p.flying || p.waitingForGround || !this.meetup.me
      || this.panels.some((e) => !e.hidden);
    this.still = busy ? 0 : this.still + dt;
    const doing = idleAt(this.still, seedOf(this.meetup.me?.id ?? "me"));
    if (!doing) return this.putAway();
    if (this.shot === null) this.shot = this.findShot();
    if (!this.shot) return; // no room to stand back here: friends still see me fidget
    this.showOwn(dt, doing);
  }

  /** Where the camera can stand to watch my animal: in front of it if there is room, or round to one side. */
  findShot() {
    const p = this.player;
    const chest = new THREE.Vector3(p.position.x, p.position.y + 1.0, p.position.z);
    let best = null;
    for (const turn of [0, 0.7, -0.7, 1.4, -1.4, Math.PI]) {
      const a = p.yaw + turn;
      const wall = p.hit(chest, new THREE.Vector3(Math.sin(a), 0, -Math.cos(a)), CAMERA_M + 0.6);
      const room = wall ? wall.distance - 0.5 : CAMERA_M;
      if (room >= CAMERA_M - 0.01) return { turn, far: CAMERA_M };
      if (!best || room > best.far) best = { turn, far: room };
    }
    return best && best.far >= ROOM_M ? best : false;
  }

  showOwn(dt, doing) {
    const p = this.player, me = this.meetup.me, shot = this.shot;
    if (this.own && this.own.avatar !== me.avatar) this.putAway(true);
    if (!this.own) {
      this.own = { group: makeAnimal(me.avatar), avatar: me.avatar, hat: null, hatMesh: null, bubble: null };
      this.scene.add(this.own.group);
    }
    const own = this.own;
    if ((me.hat ?? null) !== own.hat) {
      own.hatMesh?.removeFromParent();
      own.hat = me.hat ?? null;
      own.hatMesh = own.hat ? makeHat(own.hat) : null;
      if (own.hatMesh) wearHat(own.group, own.hatMesh);
    }
    // It turns to face where the camera stands, and the camera steps out from behind its eyes to there.
    const a = p.yaw + shot.turn;
    this.out = Math.min(1, this.out + dt / OUT_S);
    const e = glide(this.out);
    own.group.position.copy(p.position);
    own.group.rotation.y = -a;
    own.group.visible = e > 0.3; // not while the camera is still inside its head
    animateAnimal(own.group, dt, { speed: 0, turn: 0, inAir: false, flying: false, seated: false });
    addFidget(own.group, fidgetPose(doing.fidget, doing.u, this.pose));
    // What it says: now and then the next step on the progress bar, otherwise whatever is on its mind.
    const nudge = doing.say !== null && doing.n % 6 === 2 ? this.nudge?.() : null;
    this.speak(own, doing.say === null ? null : nudge ? `${nudge}. Shall we?` : MUTTERS[doing.say], own.hatMesh ? 2.05 : 1.8);

    const cam = this.camera;
    const from = cam.position.clone(), looking = cam.quaternion.clone();
    const to = new THREE.Vector3(p.position.x + Math.sin(a) * shot.far, p.position.y + 1.25, p.position.z - Math.cos(a) * shot.far);
    const ground = this.world.groundHeight(to.x, to.z);
    if (ground !== null && to.y < ground + 0.5) to.y = ground + 0.5;
    cam.position.lerpVectors(from, to, e);
    cam.lookAt(p.position.x, p.position.y + 1.0, p.position.z);
    cam.quaternion.slerpQuaternions(looking, cam.quaternion.clone(), e);
  }

  /** Back behind my animal's eyes: the player's own camera takes over again by itself. */
  putAway(keepShot = false) {
    if (this.own) this.scene.remove(this.own.group);
    this.own = null;
    this.out = 0;
    if (!keepShot) this.shot = null;
  }

  /** Shows what a figure is saying over its head, or nothing. `who` keeps the sprite as `bubble`. */
  speak(who, text, height) {
    if (!text) { if (who.bubble) who.bubble.visible = false; return; }
    const made = bubble(text);
    if (!who.bubble) {
      who.bubble = new THREE.Sprite(made.material);
      who.bubble.center.set(0.5, 0);
      who.bubble.renderOrder = 11;
      who.bubble.layers.set(1); // not on the little map
      who.group.add(who.bubble);
    }
    who.bubble.material = made.material;
    const tall = 0.046 + 0.036 * made.lines;
    who.bubble.scale.set(tall * made.aspect, tall, 1);
    who.bubble.position.set(0, height, 0);
    who.bubble.visible = true;
  }

  /** Friends who have not moved for half a minute fidget too, and those near enough can be read. */
  watchFriends(dt, gameOn) {
    const { avatars, meetup, player } = this;
    for (const id of this.friends.keys()) if (!avatars.shown.has(id)) this.friends.delete(id);
    for (const [id, entry] of avatars.shown) {
      const peer = meetup.peers.get(id);
      if (!peer) continue;
      let f = this.friends.get(id);
      if (!f || f.group !== entry.group) this.friends.set(id, (f = { group: entry.group, still: 0, lat: peer.lat, lon: peer.lon, yaw: peer.yaw, seed: seedOf(id), bubble: null, touched: false }));
      const moved = peer.lat !== f.lat || peer.lon !== f.lon || peer.yaw !== f.yaw;
      f.lat = peer.lat;
      f.lon = peer.lon;
      f.yaw = peer.yaw;
      f.still = moved || gameOn || peer.ride ? 0 : f.still + dt;
      const doing = idleAt(f.still, f.seed);
      if (!doing) {
        if (f.touched) { entry.group.userData.rig.all.rotation.y = 0; this.speak(f, null, 0); f.touched = false; }
        continue;
      }
      f.touched = true;
      addFidget(entry.group, fidgetPose(doing.fidget, doing.u, this.pose));
      const near = entry.group.position.distanceToSquared(player.position) < READ_M * READ_M;
      this.speak(f, near && doing.say !== null ? MUTTERS[doing.say] : null, entry.hatMesh ? 2.45 : 2.2); // above their name
    }
  }
}
