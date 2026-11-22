// Races (docs/PROTOCOL.md, "Races"). The server makes the course and says who has passed which gate;
// here the gates are stood along the road, the next one is lit up, the countdown is shown, and a
// small panel says how everyone is getting on. R sets a race up, joins one, and (for whoever set it
// up) starts it.

import * as THREE from "three";

const POST_H = 3.6;
const HALF_W = 3.6; // a gate spans a road
const box = new THREE.BoxGeometry(1, 1, 1);
const beamShape = new THREE.CylinderGeometry(1.1, 1.1, 1, 16, 1, true);
const paint = (hex, more = {}) => new THREE.MeshLambertMaterial({ color: hex, ...more });
const POST = paint(0xf4f1ea);
const KINDS = {
  start: [paint(0x3f9a45), paint(0xf4f1ea)],
  gate: [paint(0xf08a3c), paint(0xf4f1ea)],
  finish: [paint(0x26262b), paint(0xf4f1ea)],
  passed: [paint(0x9aa6b2), paint(0xc9ced4)],
};
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
          const gate = makeGate(i === 0 ? "start" : i === race.gates.length - 1 ? "finish" : "gate");
          gate.visible = false;
          this.gates.push(gate);
          this.group.add(gate);
        });
        this.scene.add(this.group);
        const me = this.meetup.me?.id;
        this.say(race.by === me ? `Your race is set up: ${race.metres} metres, ${race.gates.length} gates. Press R to start it when everyone who wants to is in.`
          : `${race.byName} has set up a race of ${race.metres} metres. Press R to join in.`);
      }
    }
    this.told = null; // the panel is written afresh
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
        for (const sq of gate.userData.squares) sq.material = KINDS[done ? "passed" : gate.userData.kind][sq.userData.tone];
      }
    });
    // A column of light over the gate I am to go through next.
    const next = me && me.time === null && race.state !== "over" ? this.gates[me.gate] : null;
    this.beam.visible = !!next?.userData.placed;
    if (this.beam.visible) this.beam.position.set(next.position.x, next.position.y + 40, next.position.z);

    // The countdown, large, and "GO!" for a moment after it.
    const until = race.state === "go" ? race.startAt - now : null;
    const count = until === null ? "" : until > 0 ? String(Math.ceil(until / 1000)) : until > -1200 ? "GO!" : "";
    if (this.banner.textContent !== count) this.banner.textContent = count;
    this.banner.hidden = !count;

    // The panel: who is in, how far along, and what R does now.
    const lines = [];
    const order = [...race.runners].sort((a, b) => (a.time ?? Infinity) - (b.time ?? Infinity) || b.gate - a.gate);
    if (race.state === "open") {
      lines.push(`Race by ${race.byName}: ${race.metres} m, ${race.gates.length} gates`, `In: ${race.runners.map((r) => r.name).join(", ")}`,
        !me ? "R: join in" : race.by === meetup.me?.id ? "R: start the race" : `Waiting for ${race.byName} to say go`);
    } else {
      const running = race.state === "go" && until <= 0;
      if (me && me.time === null && running) lines.push(`Gate ${Math.min(me.gate + 1, race.gates.length)} of ${race.gates.length} · ${mmss(now - race.startAt)}`);
      else if (race.state === "go" && until > 0) lines.push("Get to the green start gate...");
      else if (race.state === "over") lines.push("The race is over");
      order.forEach((r, i) => lines.push(`${i + 1}. ${r.name}  ${r.time !== null ? mmss(r.time) : `${r.gate}/${race.gates.length}`}`));
      if (race.state === "over") lines.push("R: set up another");
    }
    const text = lines.join("\n");
    if (text !== this.told) { this.told = text; this.panel.textContent = text; }
    this.panel.hidden = false;
  }
}
