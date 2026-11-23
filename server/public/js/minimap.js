// The little map in the top right corner: north up, the player in the middle. It shows friends, doors
// that open, where trains stop, parked cars, the player's own car, the taxi they called, the gates of
// a race, and the road to where they are being taken, with its name and how far it is. What matters
// and is off the map gets an arrow at its edge. M makes it large (with a list of what each mark is),
// hides it, and brings it back.
//
// The world on it is a picture taken from straight above, twice a second, into a small texture that
// is then drawn in the corner every frame and slid along under the player until the next picture: a
// second look at the scene twice a second, not sixty times. The marks are drawn over it on a canvas
// of their own, every other frame. The Windows game's is game/Source/EarthWalk/EarthMiniMap.cpp.
//
// What it costs, measured on Jason's PC (2026-11-23, Devonport, 128 marks): a picture takes 6 to 8 ms
// of the processor, the square in the corner 0.1 ms a frame and the marks 0.5 ms each time they are
// drawn: about 35 ms in every second at 60 frames a second, or 0.6 ms a frame on average.
// `await earthwalk.minimap.cost()` in the console measures it again.

import * as THREE from "three";
import { EDGE, KINDS, LEGEND_H, SIDE, SPAN, goingWords, nextSize, place, raceMarks, sizeName, sizeNamed, sizeSaid } from "./mapmarks.js";

/** The picture is this much wider than what is shown, so the map can slide under a moving player until the next picture. */
const SLACK = 1.28;
const RES = { 1: 256, 2: 512 };
const PICTURE_EVERY_S = 0.5;
const CAMERA_UP_M = 2000;
const MARGIN = 12; // from the corner of the screen
const INK = "#26221f";
const GOLD = "#f5c518";
/** What the camera above leaves out is on this layer: names over heads, speech and thought bubbles. */
export const NOT_ON_MAP = 1;

export class MiniMap {
  /**
   * @param {{ canvas: HTMLCanvasElement, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera,
   *   world: import("./world.js").World, player: import("./player.js").Player, meetup: import("./net.js").Meetup,
   *   riding: import("./riding.js").Riding, traffic: import("./traffic.js").Traffic, houses: import("./houses.js").Houses,
   *   orders: import("./orders.js").Orders, saved: string | undefined, save: (name: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.pen = this.canvas.getContext("2d");
    this.size = -1;
    this.still = []; // doors, parked cars and stations: looked for once a second
    this.stillAt = 0;
    this.picture = null; // where the picture in the texture was taken: { x, z, generation }
    this.pictureAt = 0;
    this.spent = { pictures: 0, pictureMs: 0, draws: 0, drawMs: 0 }; // what the map has cost, for cost()
    this.frames = 0;

    this.target = new THREE.WebGLRenderTarget(RES[1], RES[1], { depthBuffer: true });
    // Straight down from high up, with no perspective: north is the top of the picture and east its right.
    this.above = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_UP_M * 3);
    this.above.up.set(0, 0, -1);
    this.dark = new THREE.Color(0x0c1018);
    // The picture is put on the screen as one flat square.
    this.flat = new THREE.Scene();
    this.square = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: this.target.texture, depthTest: false, depthWrite: false, fog: false, toneMapped: false }));
    this.square.frustumCulled = false;
    this.flat.add(this.square);
    this.facing = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.look = new THREE.Vector3();
    this.camera.layers.enable(NOT_ON_MAP);
    this.setSize(sizeNamed(this.saved));
    addEventListener("resize", () => this.fit());
  }

  /** 0 hidden, 1 small, 2 large. */
  setSize(size) {
    this.size = size;
    this.canvas.hidden = size === 0;
    document.documentElement.style.setProperty("--map-h", size ? `${SIDE[size] + 2 * EDGE + (size === 2 ? LEGEND_H + 6 : 0) + MARGIN}px` : "0px");
    if (!size) return;
    this.target.setSize(RES[size], RES[size]);
    const half = (SPAN[size] * SLACK) / 2;
    Object.assign(this.above, { left: -half, right: half, top: half, bottom: -half });
    this.above.updateProjectionMatrix();
    this.picture = null;
    this.stillAt = 0;
    this.frames = 0;
    this.fit();
  }

  /** The marks' canvas: as sharp as the screen. */
  fit() {
    if (!this.size) return;
    const whole = SIDE[this.size] + 2 * EDGE;
    const tall = whole + (this.size === 2 ? LEGEND_H + 6 : 0);
    const sharp = Math.min(devicePixelRatio, 2);
    this.canvas.style.width = `${whole}px`;
    this.canvas.style.height = `${tall}px`;
    this.canvas.width = Math.round(whole * sharp);
    this.canvas.height = Math.round(tall * sharp);
    this.pen.setTransform(sharp, 0, 0, sharp, 0, 0);
  }

  /** The M key: small, large, hidden. Returns what to tell the player. */
  cycle() {
    this.setSize(nextSize(this.size));
    this.save(sizeName(this.size));
    return sizeSaid(this.size);
  }

  /** A new picture of the world from above, centred on a spot. */
  takePicture(x, y, z) {
    const { renderer, scene } = this;
    const started = performance.now();
    // On a whole dot of the picture, so that the picture does not shimmer as the player moves.
    const dot = (SPAN[this.size] * SLACK) / RES[this.size];
    const cx = Math.round(x / dot) * dot, cz = Math.round(z / dot) * dot;
    this.above.position.set(cx, y + CAMERA_UP_M, cz);
    this.above.lookAt(cx, y, cz);
    // No sky and no haze from up there. (The fog is pushed out of sight, not taken away: taking it away would have every material built twice.)
    const fog = scene.fog, sky = scene.background;
    const [near, farOff] = fog ? [fog.near, fog.far] : [0, 0];
    if (fog) { fog.near = 1e7; fog.far = 1e7 + 1; }
    scene.background = this.dark;
    const was = renderer.getRenderTarget();
    renderer.setRenderTarget(this.target);
    renderer.render(scene, this.above);
    renderer.setRenderTarget(was);
    scene.background = sky;
    if (fog) { fog.near = near; fog.far = farOff; }
    this.picture = { x: cx, z: cz, generation: this.world.generation };
    this.pictureAt = started;
    this.spent.pictures++;
    this.spent.pictureMs += performance.now() - started;
  }

  /** Doors that open, parked cars, and where trains stop: found once a second. */
  findStill(meX, meZ) {
    const { houses, traffic, riding } = this;
    const reach = SPAN[this.size] * 0.75; // to the corners
    this.still = houses.doorsNear(meX, meZ, reach).map((at) => ({ kind: "door", x: at.x, z: at.z }));
    for (const car of traffic.parked) {
      if (riding.hidden.has(car.id) || Math.abs(car.x - meX) > reach || Math.abs(car.z - meZ) > reach) continue;
      this.still.push({ kind: "parked", x: car.x, z: car.z });
    }
    // Stations from farther off than the map shows: the nearest is pointed to from the edge, to walk to.
    let nearest = null;
    let best = Infinity;
    for (const stop of traffic.stops({ x: meX, z: meZ }, 1500)) {
      const mark = { kind: "station", x: stop.x, z: stop.z };
      const off = (stop.x - meX) ** 2 + (stop.z - meZ) ** 2;
      if (off < best) { best = off; nearest = mark; }
      this.still.push(mark);
    }
    if (nearest) nearest.point = true;
  }

  /** Everything to mark just now, and the road to where the player is being taken. */
  gather() {
    const { world, player, meetup, riding, orders } = this;
    const marks = [...this.still];
    const me = meetup.me?.id;
    const mine = riding.mine;
    const drawn = (thing) => riding.mounts.find((m) => m.thing === thing) ?? null;
    for (const peer of meetup.peers.values()) {
      if (!peer.hasPosition) continue;
      const at = world.geoToScene(peer.lat, peer.lon);
      marks.push({ kind: "friend", x: at.x, z: at.z, label: peer.name });
    }
    const car = me ? meetup.cars.get(me) : null;
    if (car && mine?.thing !== car.thing) {
      const at = drawn(car.thing) ?? world.geoToScene(car.lat, car.lon);
      marks.push({ kind: "mycar", x: at.x, z: at.z, label: "your car" });
    }
    for (const [thing, taxi] of meetup.taxis) {
      const at = taxi.by === me && mine?.thing !== thing ? drawn(thing) : null;
      if (at) marks.push({ kind: "taxi", x: at.x, z: at.z, label: taxi.name || "your taxi" });
    }
    const race = meetup.race;
    if (race && race.state !== "over") {
      for (const { k, label } of raceMarks(race.gates.length, race.runners.find((r) => r.id === me) ?? null)) {
        const at = world.geoToScene(race.gates[k][0], race.gates[k][1]);
        marks.push({ kind: "gate", x: at.x, z: at.z, label });
      }
    }
    let way = null, going = "", goal = null;
    const trip = orders.trip;
    if (trip?.path.length) {
      going = trip.name ?? "";
      way = [player.position, ...trip.path.slice(Math.min(Math.max(trip.i, 0), trip.path.length - 1))];
      const end = trip.path[trip.path.length - 1];
      goal = { kind: "goal", x: end.x, z: end.z, label: going };
      marks.push(goal);
    }
    return { marks, way, going, goal };
  }

  /** Every frame, after the world has been drawn: the picture into the corner, and the marks over it. */
  frame() {
    if (!this.size) return;
    const { renderer, player, pen } = this;
    const side = SIDE[this.size], span = SPAN[this.size];
    const meX = player.position.x, meZ = player.position.z;
    const now = performance.now();
    if (now - this.stillAt > 1000) {
      this.stillAt = now;
      this.findStill(meX, meZ);
    }

    // A new picture twice a second, or at once when the player has outrun the last one (sent somewhere else, say).
    const room = (span * SLACK - span) / 2;
    const old = this.picture;
    if (!old || old.generation !== this.world.generation || Math.max(Math.abs(meX - old.x), Math.abs(meZ - old.z)) > room || now - this.pictureAt > PICTURE_EVERY_S * 1000) {
      this.takePicture(meX, player.position.y, meZ);
    }
    const started = performance.now();
    // The part of the picture that is round the player now, into the corner of the screen.
    const shown = 1 / SLACK;
    const picture = this.target.texture;
    picture.repeat.set(shown, shown);
    picture.offset.set(0.5 + (meX - this.picture.x) / (span * SLACK) - shown / 2, 0.5 - (meZ - this.picture.z) / (span * SLACK) - shown / 2);
    const left = innerWidth - MARGIN - EDGE - side, bottom = innerHeight - MARGIN - EDGE - side;
    const clear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setViewport(left, bottom, side, side);
    renderer.setScissor(left, bottom, side, side);
    renderer.setScissorTest(true);
    renderer.render(this.flat, this.facing);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, innerWidth, innerHeight);
    renderer.autoClear = clear;
    this.spent.drawMs += performance.now() - started;
    if (this.frames++ % 2) return; // the marks every other frame: half a pixel behind at most, in a fast car
    const marksStarted = performance.now();

    // ---- the marks
    const { marks, way, going, goal } = this.gather();
    const whole = side + 2 * EDGE;
    const mid = EDGE + side / 2;
    pen.clearRect(0, 0, whole, whole + LEGEND_H + 6);
    pen.lineJoin = "round";
    pen.lineCap = "round";
    pen.save();
    pen.beginPath();
    pen.rect(EDGE, EDGE, side, side);
    pen.clip();
    const perMetre = side / span;
    // The road to where the player is being taken.
    if (way && way.length > 1) {
      pen.beginPath();
      way.forEach((p, i) => pen[i ? "lineTo" : "moveTo"](mid + (p.x - meX) * perMetre, mid + (p.z - meZ) * perMetre));
      this.stroke(INK, 6);
      this.stroke(GOLD, 3);
    }
    // Doors and parked cars are many, and small: all of a kind are drawn in one go.
    for (const kind of ["door", "parked"]) {
      const k = KINDS[kind], half = k.wide / 2;
      pen.beginPath();
      for (const m of marks) {
        if (m.kind !== kind) continue;
        const at = place(kind, m.x - meX, m.z - meZ, side, span);
        if (!at) continue;
        if (k.shape === "square") pen.rect(mid + at.x - half, mid + at.y - half, k.wide, k.wide);
        else { pen.moveTo(mid + at.x + half, mid + at.y); pen.arc(mid + at.x, mid + at.y, half, 0, Math.PI * 2); }
      }
      pen.fillStyle = k.colour;
      pen.fill();
      this.stroke(INK, 1);
    }
    // The rest are few, and stand out; and at the map's edge, pointing the way, what matters and is off it.
    const order = (m) => (KINDS[m.kind].points ? 1 : 0);
    for (const m of marks.filter((each) => each.kind !== "door" && each.kind !== "parked").sort((a, b) => order(a) - order(b))) {
      const at = place(m.kind, m.x - meX, m.z - meZ, side, span, m.point);
      if (!at) continue;
      const x = mid + at.x, y = mid + at.y;
      if (at.on) {
        this.symbol(m.kind, x, y);
        if (m.label && (this.size === 2 || m.kind === "friend")) this.words(m.label.slice(0, 18), x + 10, y, "left");
        continue;
      }
      // An arrowhead, pointing out.
      pen.beginPath();
      pen.moveTo(x - at.ax * 5 - at.ay * 6, y - at.ay * 5 + at.ax * 6);
      pen.lineTo(x + at.ax * 5, y + at.ay * 5);
      pen.lineTo(x - at.ax * 5 + at.ay * 6, y - at.ay * 5 - at.ax * 6);
      this.stroke(INK, 7);
      this.stroke(KINDS[m.kind].colour, 4);
      if (m.kind === "friend" && m.label) {
        // The name, inside the arrow: read away from whichever side of the map the arrow is on.
        const align = at.ax < -0.4 ? "left" : at.ax > 0.4 ? "right" : "center";
        const nameX = align === "left" ? x + 11 : align === "right" ? x - 11 : Math.min(Math.max(x, EDGE + 40), EDGE + side - 40);
        const nameY = align !== "center" ? y : at.ay < 0 ? y + 15 : y - 15;
        this.words(m.label.slice(0, 12), nameX, Math.min(Math.max(nameY, EDGE + 9), EDGE + side - 11), align);
      }
    }
    // The player: an arrowhead on the spot, pointing the way they look.
    this.camera.getWorldDirection(this.look);
    const turn = Math.hypot(this.look.x, this.look.z) > 0.05 ? Math.atan2(this.look.x, -this.look.z) : player.yaw;
    const ax = Math.sin(turn), ay = -Math.cos(turn);
    pen.beginPath();
    pen.moveTo(mid + ax * 10, mid + ay * 10);
    pen.lineTo(mid - ax * 7 - ay * 7, mid - ay * 7 + ax * 7);
    pen.lineTo(mid - ax * 2.5, mid - ay * 2.5);
    pen.lineTo(mid - ax * 7 + ay * 7, mid - ay * 7 - ax * 7);
    pen.closePath();
    this.stroke(INK, 5);
    pen.fillStyle = "#fff";
    pen.fill();
    this.stroke("#fff", 1.5);
    // North, the key that changes the map, and where the player is being taken.
    this.words("N", mid, EDGE + 10, "center", 12);
    let foot = EDGE + side;
    if (going) {
      foot -= 22;
      pen.fillStyle = "rgba(13, 18, 26, 0.82)";
      pen.fillRect(EDGE, foot, side, 22);
      this.words(goingWords(going, goal ? Math.hypot(goal.x - meX, goal.z - meZ) : NaN, this.size), mid, foot + 11.5, "center", 12, GOLD);
    }
    pen.beginPath();
    pen.roundRect(EDGE + 5, foot - 23, 18, 18, 4);
    pen.fillStyle = GOLD;
    pen.fill();
    this.stroke(INK, 1.5);
    this.words("M", EDGE + 14, foot - 13.5, "center", 12, INK, false);
    pen.restore();
    // The frame, over the edge of the picture.
    pen.beginPath();
    pen.roundRect(EDGE / 2, EDGE / 2, whole - EDGE, whole - EDGE, 4);
    this.stroke(INK, EDGE);

    // Under the large map: what each mark is.
    if (this.size === 2) {
      const top = whole + 6;
      pen.beginPath();
      pen.roundRect(0, top, whole, LEGEND_H, 8);
      pen.fillStyle = "rgba(22, 28, 38, 0.92)";
      pen.fill();
      Object.entries(KINDS).forEach(([kind, k], i) => {
        const x = 18 + Math.floor(i / 4) * (whole / 2), y = top + 15 + (i % 4) * 21;
        this.symbol(kind, x, y);
        this.words(k.words, x + 14, y + 0.5, "left", 13, "#fff", false, "400");
      });
    }
    this.spent.draws++;
    this.spent.drawMs += performance.now() - marksStarted;
  }

  /** Strokes the path just made, and keeps it for another line over the top. */
  stroke(colour, width) {
    this.pen.strokeStyle = colour;
    this.pen.lineWidth = width;
    this.pen.stroke();
  }

  /** One mark, centred on a spot: a disc or a square in its colour with an ink line round it. */
  symbol(kind, x, y) {
    const { pen } = this;
    const k = KINDS[kind];
    const half = k.wide / 2;
    pen.beginPath();
    if (k.shape === "square") pen.roundRect(x - half, y - half, k.wide, k.wide, k.wide > 8 ? 2.5 : 1);
    else pen.arc(x, y, half, 0, Math.PI * 2);
    pen.fillStyle = k.colour;
    pen.fill();
    this.stroke(INK, k.wide > 8 ? 2 : 1); // doors and parked cars are many, and small; the rest are few, and stand out
    if (kind === "goal") {
      pen.beginPath();
      pen.arc(x, y, 3, 0, Math.PI * 2);
      pen.fillStyle = "#fff";
      pen.fill();
    } else if (k.letter) this.words(k.letter, x, y + 0.5, "center", 10, INK, false);
  }

  /** Words on the map. A dark copy a pixel off makes them read over anything. */
  words(text, x, y, align = "left", size = 11, colour = "#fff", shadow = true, weight = "700") {
    const { pen } = this;
    pen.font = `${weight} ${size}px system-ui, sans-serif`;
    pen.textAlign = align;
    pen.textBaseline = "middle";
    if (shadow) {
      pen.fillStyle = "rgba(0, 0, 0, 0.9)";
      pen.fillText(text, x + 1, y + 1);
    }
    pen.fillStyle = colour;
    pen.fillText(text, x, y);
  }

  /**
   * What the map costs: the map is hidden, small and large by turns for `each` seconds, `rounds` times
   * round, and the time between frames in each is measured, with the time the map itself took.
   * From the console: `await earthwalk.minimap.cost()`.
   */
  async cost(each = 4, rounds = 3) {
    const before = this.size;
    const sum = [0, 0, 0], frames = [0, 0, 0], mapMs = [0, 0, 0];
    for (let phase = 0; phase < 3 * rounds; phase++) {
      const size = phase % 3;
      this.setSize(size);
      await new Promise((done) => setTimeout(done, 1000)); // let it settle
      this.spent = { pictures: 0, pictureMs: 0, draws: 0, drawMs: 0 };
      const started = performance.now();
      let n = 0;
      await new Promise((done) => {
        const tick = () => { n++; if (performance.now() - started < each * 1000) requestAnimationFrame(tick); else done(); };
        requestAnimationFrame(tick);
      });
      sum[size] += performance.now() - started;
      frames[size] += n;
      mapMs[size] += this.spent.pictureMs + this.spent.drawMs;
    }
    this.setSize(before);
    const row = (size) => ({ frameMs: +(sum[size] / frames[size]).toFixed(2), fps: +((frames[size] * 1000) / sum[size]).toFixed(1), mapMsPerFrame: +(mapMs[size] / frames[size]).toFixed(3) });
    return { hidden: row(0), small: row(1), large: row(2) };
  }
}
