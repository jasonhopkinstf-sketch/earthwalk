// Talking to things. Walk up to an animal, a car, a train, a tree or a house and press T: it says
// hello in a speech bubble of its own at the foot of the screen (menu.js), with a line there to
// answer on. What it says also floats in a bubble above it, for everyone nearby. None of it goes
// into the chat window: that is for people.
//
// Who each thing is (its name, its character) is decided on the server from its identity, so it is
// the same for everyone (docs/PROTOCOL.md, "Talking").

import * as THREE from "three";
import { hash32 } from "./lifemotion.js";

/** What each kind of thing is called. */
export const CALLED = {
  cow: "cow", sheep: "sheep", horse: "horse", chicken: "hen", duck: "duck", pigeon: "pigeon", bird: "bird", cat: "cat", dog: "dog",
  rabbit: "rabbit", deer: "deer", squirrel: "squirrel", kangaroo: "kangaroo", llama: "llama", camel: "camel", penguin: "penguin",
  pig: "pig", goat: "goat", donkey: "donkey", goose: "goose", mouse: "mouse", hedgehog: "hedgehog", fox: "fox", frog: "frog", snail: "snail",
  tortoise: "tortoise", crab: "crab", beaver: "beaver", otter: "otter", swan: "swan", heron: "heron", seagull: "seagull", sparrow: "sparrow",
  flamingo: "flamingo", seal: "seal", butterfly: "butterfly", bee: "bee", dragonfly: "dragonfly", ladybird: "ladybird", ant: "ant",
  grasshopper: "grasshopper", elephant: "elephant", giraffe: "giraffe", zebra: "zebra", lion: "lion", monkey: "monkey", panda: "panda",
  koala: "koala", bear: "bear", moose: "moose", bison: "bison", reindeer: "reindeer", capybara: "capybara", marmot: "marmot",
  tractor: "tractor", boat: "rowing boat", sailboat: "sailing boat", car: "car", taxi: "taxi", train: "train", tree: "tree", house: "house",
};
/** How high above the ground its speech bubble floats, and how near you must be to talk to it. */
const BUBBLE_AT = { elephant: 4.2, giraffe: 5.4, moose: 2.9, bison: 2.5, bear: 2.2, zebra: 2.3, lion: 1.9, reindeer: 2.4, donkey: 2.2, panda: 1.7, flamingo: 1.9, heron: 1.7, tree: 4.5, house: 3.4, train: 4.8, camel: 3.2, horse: 2.8, llama: 2.7, deer: 2.4, cow: 2.2, tractor: 3.1, sailboat: 4.2, car: 2.3, taxi: 2.5, kangaroo: 2.2 };
const REACH = { tree: 4, house: 7, train: 9, sailboat: 7, tractor: 6, car: 5, taxi: 5 };
const REACH_M = 5.5;
const WALKED_OFF_M = 16;
const BUBBLE_SECONDS = 8;
const SALT = { tree: 0x54524545, house: 0x484f5553 };

/** The identity of a thing that stays put: worked out from where it stands, so everyone gets the same one. */
export const fixedThing = (kind, wx, wy) => hash32(hash32(Math.round(wx * 8192), Math.round(wy * 8192)), SALT[kind]) || 1;

/** A speech bubble: a rounded card with the speaker's name and wrapped words, always facing the camera. */
function bubble(name, text) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  const font = "500 34px system-ui, sans-serif";
  const bold = "700 30px system-ui, sans-serif";
  ctx.font = font;
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    const next = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(next).width > 520) { lines.push(line); line = word; } else line = next;
  }
  if (line) lines.push(line);
  const width = Math.max(ctx.measureText(name).width, ...lines.map((l) => ctx.measureText(l).width)) + 56;
  canvas.width = Math.ceil(width);
  canvas.height = 64 + lines.length * 42;
  ctx.fillStyle = "rgba(255, 253, 244, 0.96)";
  ctx.strokeStyle = "#26221f";
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.roundRect(3, 3, canvas.width - 6, canvas.height - 6, 26);
  ctx.fill();
  ctx.stroke();
  ctx.textBaseline = "top";
  ctx.fillStyle = "#8a4f2d";
  ctx.font = bold;
  ctx.fillText(name, 28, 16);
  ctx.fillStyle = "#26221f";
  ctx.font = font;
  lines.forEach((l, i) => ctx.fillText(l, 28, 54 + i * 42));
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  // The same size on screen however far off, and drawn over everything, so it can always be read.
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, sizeAttenuation: false, depthTest: false, transparent: true }));
  const h = 0.00068 * canvas.height;
  sprite.scale.set((h * canvas.width) / canvas.height, h, 1);
  sprite.center.set(0.5, 0);
  sprite.renderOrder = 11;
  return sprite;
}

export class Talk {
  /**
   * @param {{ scene: THREE.Scene, world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   life: import("./life.js").Life, traffic: import("./traffic.js").Traffic, riding: import("./riding.js").Riding,
   *   hint: (text: string) => void, said: (msg: { thing: number, sp: string, name: string, text: string }) => void, changed: () => void }} parts
   *   `said` hears everything a thing says near me; `changed` is told when who I am talking to changes, or has told me its name.
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.to = null; // who I am talking to: { thing, sp, x, z }
    this.near = null; // who T would talk to
    this.names = new Map(); // thing -> its name, once it has spoken
    this.bubbles = new Map(); // thing -> { sprite, until, sp, lift }
    this.sinceScan = 0;
    this.meetup.addEventListener("say", (e) => this.heard(e.detail));
  }

  /** "Daisy the cow", or "the cow" until she has introduced herself. */
  title(c) {
    const name = this.names.get(c.thing);
    return name ? `${name} the ${CALLED[c.sp]}` : `the ${CALLED[c.sp]}`;
  }

  /** The T key: say hello to whatever is nearest. Returns true if there was something to talk to. */
  begin() {
    if (!this.near || !this.meetup.joined) return false;
    this.to = { ...this.near };
    this.meetup.sendTalk(this.to.thing, this.to.sp);
    this.changed();
    return true;
  }

  /** Turns to whatever I am riding, to tell it where to go. True if I am on something that can be spoken to. */
  beginRide() {
    const mine = this.riding.mine;
    if (!mine || !CALLED[mine.sp] || !this.meetup.joined) return false;
    if (this.to?.thing === mine.thing) return true;
    const at = [...this.riding.mounts, ...this.traffic.rideable].find((c) => c.thing === mine.thing) ?? { x: this.player.position.x, z: this.player.position.z };
    this.to = { thing: mine.thing, sp: mine.sp, x: at.x, z: at.z };
    this.meetup.sendTalk(this.to.thing, this.to.sp);
    this.changed();
    return true;
  }

  /** Something typed while talking to a thing goes to it. */
  say(text) {
    if (this.to) this.meetup.sendTalk(this.to.thing, this.to.sp, text, this.world.sceneToGeo({ x: this.to.x, y: 0, z: this.to.z }));
  }

  stop() {
    if (!this.to) return;
    this.to = null;
    this.changed();
  }

  /**
   * Where a thing is being drawn just now, if this game is drawing it: { x, z }. Things move: a taxi tells
   * its story as it drives, a cow answers as it follows. `near` picks between the carriages of a train.
   */
  whereIs(thing, sp, near = this.player.position) {
    for (const m of this.riding.mounts) if (m.thing === thing) return m; // ridden, left standing, doing as it was told, a taxi on its way
    let best = null;
    let bestD = Infinity;
    for (const c of this.traffic.rideable) {
      if (c.thing !== thing || c.sp !== sp) continue;
      const d = Math.hypot(c.x - near.x, c.z - near.z);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best) return best;
    for (const c of this.life.nearby) if (c.thing === thing && c.sp === sp) return c;
    return null;
  }

  /** Everything near enough to talk to, nearest first: animals, cars and trains, whatever is being ridden, trees and houses. */
  scan() {
    const { world, player: p } = this;
    const S = world.tileM;
    let best = null;
    let bestD = Infinity;
    const consider = (c, handicap = 0) => {
      if (!CALLED[c.sp]) return;
      const d = Math.hypot(c.x - p.position.x, c.z - p.position.z);
      if (d < (REACH[c.sp] ?? REACH_M) && d + handicap < bestD) { bestD = d + handicap; best = c; }
      if (this.to && this.to.thing === c.thing && this.to.sp === c.sp) { this.to.x = c.x; this.to.z = c.z; } // it may have wandered
    };
    for (const c of this.life.nearby) consider(c);
    for (const c of this.traffic.rideable) consider(c);
    for (const m of this.riding.mounts) consider(m);
    // Trees and houses stand still, so they yield to anything livelier that is just as close.
    const here = world.chunkAt(p.position.x, p.position.z);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const chunk = world.chunks.get(`${here.cx + dx}/${here.cy + dy}`);
        for (const [kind, items] of [["tree", chunk?.treeItems], ["house", chunk?.houses]]) {
          for (const it of items ?? []) {
            const x = (chunk.x + it.u - world.originX) * S;
            const z = (chunk.y + it.v - world.originY) * S;
            if (Math.abs(x - p.position.x) > 8 || Math.abs(z - p.position.z) > 8) continue;
            consider({ thing: fixedThing(kind, chunk.x + it.u, chunk.y + it.v), sp: kind, x, z }, 1.5);
          }
        }
      }
    }
    this.near = best;
  }

  /** Every frame. */
  frame(dt) {
    const p = this.player;
    if ((this.sinceScan += dt) > 0.2) {
      this.sinceScan = 0;
      if (p.waitingForGround) this.near = null; else this.scan();
      if (this.to && (p.waitingForGround || Math.hypot(this.to.x - p.position.x, this.to.z - p.position.z) > WALKED_OFF_M)) this.stop();
      this.hint(!this.to && this.near ? `T: talk to ${this.title(this.near)}` : "");
    }
    const now = performance.now();
    for (const [thing, b] of this.bubbles) {
      if (now > b.until) {
        this.scene.remove(b.sprite);
        b.sprite.material.map.dispose();
        b.sprite.material.dispose();
        this.bubbles.delete(thing);
      } else {
        b.sprite.material.opacity = Math.min(1, (b.until - now) / 600);
        // The bubble goes along with whoever is speaking.
        const at = this.whereIs(thing, b.sp, b.sprite.position);
        const ground = at ? this.world.groundHeight(at.x, at.z) : null;
        if (ground !== null) b.sprite.position.set(at.x, ground + b.lift, at.z);
      }
    }
  }

  /** A thing has spoken: to me, or to somebody near me. */
  heard(msg) {
    if (!CALLED[msg.sp] || typeof msg.text !== "string" || typeof msg.name !== "string") return;
    const { world, meetup } = this;
    this.names.set(msg.thing, msg.name);
    this.said(msg);

    // Where is it? Where this game is drawing it, if it is; otherwise where the player who spoke to it stands.
    let at = this.whereIs(msg.thing, msg.sp);
    if (!at && this.to?.thing === msg.thing) at = this.to;
    if (!at && this.near?.thing === msg.thing) at = this.near;
    if (!at && typeof msg.lat === "number") {
      const spot = world.geoToScene(msg.lat, msg.lon);
      at = { x: spot.x, z: spot.z };
    }
    if (!at) return;
    const ground = world.groundHeight(at.x, at.z);
    if (ground === null) return;
    const old = this.bubbles.get(msg.thing);
    if (old) this.scene.remove(old.sprite);
    const sprite = bubble(msg.name, msg.text);
    const lift = BUBBLE_AT[msg.sp] ?? 1.5;
    sprite.position.set(at.x, ground + lift, at.z);
    this.scene.add(sprite);
    this.bubbles.set(msg.thing, { sprite, sp: msg.sp, lift, until: performance.now() + (BUBBLE_SECONDS + msg.text.length * 0.04) * 1000 });
    this.life.speak(msg.sp, msg.thing, at.x, at.z); // and its own voice with it, if it has one
    if (this.to?.thing === msg.thing) this.changed();
  }
}
