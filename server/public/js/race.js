// Races (docs/PROTOCOL.md, "Races"). The server makes the course and says who has passed which gate;
// here the gates are stood along the road, the next one is lit up, the countdown is shown, and a
// small panel says how everyone is getting on. R sets a race up, joins one, and (for whoever set it
// up) starts it.

import * as THREE from "three";
import { paint as lookPaint } from "./look.js";

const POST_H = 3.6;
const HALF_W = 3.6; // a gate spans a road
const box = new THREE.BoxGeometry(1, 1, 1);
const beamShape = new THREE.CylinderGeometry(1.1, 1.1, 1, 16, 1, true);
const paint = (hex, more = {}) => lookPaint({ color: hex, ...more });
const POST = paint(0xf4f1ea);
const KINDS = {
  start: [paint(0x3f9a45), paint(0xf4f1ea)],
  gate: [paint(0xf08a3c), paint(0xf4f1ea)],
  finish: [paint(0x26262b), paint(0xf4f1ea)],
  passed: [paint(0x9aa6b2), paint(0xc9ced4)],
};
/** An agility course's obstacles (race.ts): each a small thing to run at, built to face along the course. */
const RED = paint(0xd9382e), WHITE = paint(0xf4f1ea), BLUE = paint(0x3f6fb0), GOLD = paint(0xe0b23c), GREEN = paint(0x3f9a45), DARK = paint(0x26262b), GREY = paint(0x9aa6b2);
const rod = new THREE.CylinderGeometry(0.05, 0.05, 1, 8);
const ring = new THREE.TorusGeometry(0.8, 0.07, 8, 24);
const arch = new THREE.CylinderGeometry(0.95, 0.95, 2.6, 16, 1, true, 0, Math.PI);
function pole(material, height, x, z) {
  const mesh = new THREE.Mesh(rod, material);
  mesh.scale.set(1, height, 1);
  mesh.position.set(x, height / 2, z);
  return mesh;
}
function makeObstacle(kind) {
  const g = new THREE.Group();
  const tinted = []; // the parts that go grey once I am past
  const add = (mesh) => { tinted.push({ mesh, was: mesh.material }); g.add(mesh); return mesh; };
  if (kind === "start" || kind === "finish") {
    const tone = kind === "start" ? [GREEN, WHITE] : [DARK, WHITE];
    for (const side of [-1, 1]) g.add(pole(WHITE, 2.4, side * 1.3, 0));
    for (let i = 0; i < 8; i++) add(part(tone[i % 2], [0.325, 0.3, 0.06], [-1.3 + 0.325 * (i + 0.5), 2.25, 0]));
  } else if (kind === "jump") {
    for (const side of [-1, 1]) add(pole(RED, 1.1, side * 0.9, 0));
    add(part(WHITE, [1.8, 0.09, 0.09], [0, 0.55, 0]));
    add(part(RED, [0.5, 0.1, 0.1], [0, 0.55, 0]));
  } else if (kind === "hoop") {
    g.add(pole(WHITE, 0.5, 0, 0));
    const hoop = add(new THREE.Mesh(ring, GOLD));
    hoop.position.set(0, 1.3, 0);
  } else if (kind === "weave") {
    for (let i = 0; i < 5; i++) add(pole(i % 2 ? BLUE : GOLD, 1.2, 0, (i - 2) * 0.7));
  } else if (kind === "tunnel") {
    const tube = add(new THREE.Mesh(arch, paint(0x3f6fb0, { side: THREE.DoubleSide })));
    tube.rotation.set(Math.PI / 2, 0, Math.PI / 2); // lying along the course, open underneath
    tube.position.set(0, 0, 0);
  } else {
    add(part(GOLD, [1.3, 0.35, 1.3], [0, 0.175, 0])); // the table: up, and off again
  }
  g.userData = { kind, tinted, placed: false, obstacle: true };
  return g;
}

const BEAM = new THREE.MeshBasicMaterial({ color: 0xffd84a, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide });

function part(material, scale, position) {
  const mesh = new THREE.Mesh(box, material);
  mesh.scale.set(...scale);
  mesh.position.set(...position);
  return mesh;
}

/** One gate: two posts and a banner of squares across the top, in the two colours of its kind. */
function makeGate(kind) {
  const g = new THREE.Group();
  for (const side of [-1, 1]) g.add(part(POST, [0.22, POST_H, 0.22], [side * HALF_W, POST_H / 2, 0]));
  const squares = [];
  const across = 12, down = kind === "gate" ? 1 : 2;
  const size = (HALF_W * 2) / across;
  for (let i = 0; i < across; i++) {
    for (let j = 0; j < down; j++) {
      const sq = part(KINDS[kind][(i + j) % 2], [size, size, 0.1], [-HALF_W + size * (i + 0.5), POST_H - size * (j + 0.5), 0]);
      sq.userData.tone = (i + j) % 2;
      squares.push(sq);
      g.add(sq);
    }
  }
  g.userData = { kind, squares, placed: false };
  return g;
}

const mmss = (ms) => {
  const s = Math.max(0, ms) / 1000;
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, "0")}`;
};

export class Races {
  /**
   * @param {{ scene: THREE.Scene, world: import("./world.js").World, meetup: import("./net.js").Meetup,
   *   panel: HTMLElement, banner: HTMLElement, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.group = null;
    this.gates = [];
    this.course = "";
    this.beam = new THREE.Mesh(beamShape, BEAM);
    this.beam.scale.set(1, 80, 1);
    this.beam.visible = false;
    this.scene.add(this.beam);
    this.meetup.addEventListener("race", () => this.heard());
  }

  get race() {
    return this.meetup.race;
  }

  get mine() {
    return this.race?.runners.find((r) => r.id === this.meetup.me?.id) ?? null;
  }

  /** The race has changed: say so when it is news, and stand the gates up if the course is new. */
  heard() {
    const race = this.race;
    const key = race ? `${race.by}:${race.made}` : "";
    if (key !== this.course) {
      this.course = key;
      if (this.group) this.scene.remove(this.group);
      this.group = null;
      this.gates = [];
      if (race) {
        this.group = new THREE.Group();
        race.gates.forEach((_, i) => {
          const gate = race.kind === "agility" ? makeObstacle(race.obstacles?.[i] ?? "jump") : makeGate(i === 0 ? "start" : i === race.gates.length - 1 ? "finish" : "gate");
          gate.visible = false;
          this.gates.push(gate);
          this.group.add(gate);
        });
        this.scene.add(this.group);
        const me = this.meetup.me?.id;
        if (race.kind === "agility") this.say(race.by === me ? `An agility course is set up before you: ${race.gates.length} obstacles in a ring. Press R to start, then run it in order with your companion at your heels. The light shows the next one.`
          : `${race.byName} has set up an agility course. Press R to join in.`);
        else this.say(race.by === me ? `Your race is set up: ${race.metres} metres, ${race.gates.length} gates. Press R to start it when everyone who wants to is in.`
          : `${race.byName} has set up a race of ${race.metres} metres. Press R to join in.`);
      }
    }
    // On an agility course, a companion leaps as its runner comes to a jump or a hoop.
    const before = this.reached ?? new Map();
    this.reached = new Map();
    for (const r of race?.runners ?? []) {
      this.reached.set(r.id, r.gate);
      const kind = race.kind === "agility" && r.gate > (before.get(r.id) ?? r.gate) ? race.obstacles?.[r.gate - 1] : null;
      if (kind === "jump" || kind === "hoop" || kind === "table") this.pets?.hop(r.id);
    }
    this.told = null; // the panel is written afresh
  }

  /** Sets an agility course up before me, for me and my companion. */
  agility() {
    const { meetup, race } = this;
    if (!meetup.joined) return;
    if (race && race.state !== "over") return this.say("There is a race set up already: R joins or starts it, /race stop ends it.");
    meetup.sendAgility();
  }

  /** The R key, or "/race" with a word. */
  key(word = "") {
    const { meetup, race } = this;
    if (!meetup.joined) return;
    if (word === "stop" || word === "leave") return race ? meetup.sendRace("stop") : this.say("There is no race just now.");
    if (!race || race.state === "over") {
      this.say("Setting up a race along the roads here...");
      return meetup.sendRace("make");
    }
    if (race.state !== "open") return;
    if (!this.mine) return meetup.sendRace("join");
    if (race.by === meetup.me?.id) return meetup.sendRace("go");
    this.say(`You are in. ${race.byName} says when to go.`);
  }

  /** Every frame. */
  frame() {
    const { race, world, meetup } = this;
    if (!race) {
      this.beam.visible = false;
      if (!this.panel.hidden) { this.panel.hidden = true; this.banner.hidden = true; }
      return;
    }
    const now = meetup.now() * 1000;
    const me = this.mine;
    // Stand each gate on the ground, across the road, once the ground there has arrived.
    race.gates.forEach(([lat, lon], i) => {
      const gate = this.gates[i];
      if (!gate) return;
      if (!gate.userData.placed) {
        const at = world.geoToScene(lat, lon);
        const y = world.groundHeight(at.x, at.z);
        if (y === null) return;
        const a = world.geoToScene(...race.gates[Math.max(0, i - 1)]), b = world.geoToScene(...race.gates[Math.min(race.gates.length - 1, i + 1)]);
        gate.position.set(at.x, y, at.z);
        gate.rotation.y = Math.atan2(b.x - a.x, b.z - a.z); // its banner faces along the course
        gate.visible = true;
        gate.userData.placed = true;
      }
      // Gates I have been through go grey (the finish keeps its chequers).
      const done = !!me && i < me.gate && i < race.gates.length - 1;
      if (gate.userData.done !== done) {
        gate.userData.done = done;
        if (gate.userData.obstacle) for (const t of gate.userData.tinted) t.mesh.material = done ? GREY : t.was;
        else for (const sq of gate.userData.squares) sq.material = KINDS[done ? "passed" : gate.userData.kind][sq.userData.tone];
      }
    });
    // A column of light over the gate I am to go through next.
    const next = me && me.time === null && race.state !== "over" ? this.gates[me.gate] : null;
    this.beam.visible = !!next?.userData.placed;
    if (this.beam.visible) {
      this.beam.position.set(next.position.x, next.position.y + 40, next.position.z);
      const wide = race.kind === "agility" ? 0.7 : 1;
      this.beam.scale.set(wide, 80, wide);
    }

    // The countdown, large, and "GO!" for a moment after it.
    const until = race.state === "go" ? race.startAt - now : null;
    const count = until === null ? "" : until > 0 ? String(Math.ceil(until / 1000)) : until > -1200 ? "GO!" : "";
    if (this.banner.textContent !== count) this.banner.textContent = count;
    this.banner.hidden = !count;

    // The panel: who is in, how far along, and what R does now.
    const lines = [];
    const order = [...race.runners].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || b.gate - a.gate);
    const agile = race.kind === "agility";
    if (race.state === "open") {
      lines.push(agile ? `Agility course by ${race.byName}: ${race.gates.length} obstacles` : `Race by ${race.byName}: ${race.metres} m, ${race.gates.length} gates`, `In: ${race.runners.map((r) => r.name).join(", ")}`,
        !me ? "R: join in" : race.by === meetup.me?.id ? (agile ? "R: start" : "R: start the race") : `Waiting for ${race.byName} to say go`);
    } else {
      const running = race.state === "go" && until <= 0;
      if (me && me.time === null && running) lines.push(`${agile ? (race.obstacles?.[me.gate] === "weave" ? "Weave poles" : race.obstacles?.[me.gate] === "table" ? "Table" : race.obstacles?.[me.gate] === "tunnel" ? "Tunnel" : race.obstacles?.[me.gate] === "hoop" ? "Hoop" : race.obstacles?.[me.gate] === "finish" ? "Finish" : race.obstacles?.[me.gate] === "start" ? "Start" : "Jump") : "Gate"} ${Math.min(me.gate + 1, race.gates.length)} of ${race.gates.length} · ${mmss(now - race.startAt)}`);
      else if (race.state === "go" && until > 0) lines.push(agile ? "Get to the green start..." : "Get to the green start gate...");
      else if (race.state === "over") lines.push(agile ? "The round is over" : "The race is over");
      order.forEach((r, i) => lines.push(`${i + 1}. ${r.name}  ${r.time !== null ? mmss(r.time) : `${r.gate}/${race.gates.length}`}`));
      if (race.state === "over") lines.push("R: set up another");
    }
    const text = lines.join("\n");
    if (text !== this.told) { this.told = text; this.panel.textContent = text; }
    this.panel.hidden = false;
  }
}
