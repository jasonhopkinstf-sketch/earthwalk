// The world map: a street map of the whole Earth to look round on, and to choose a place from. Drag it
// to move it, turn the wheel to come closer or stand back, and click where you want to go: it names the
// place, and offers a taxi there, a flight there, or going there at once. N opens it and puts it away.
//
// The game itself draws only the world near the player, so the map is made of pictures: squares of
// OpenStreetMap's own map, which reach this page through the game's server (server/src/maptiles.ts) and
// never straight from OpenStreetMap, so that nobody outside learns who looked at what. Their credit is
// on the map, as they ask. The player, their friends and the place chosen are drawn over the pictures.
// The Windows game's is game/Source/EarthWalk/EarthWorldMap.cpp, by the same sums (mapview.js).

import { MAX_ZOOM, MIN_ZOOM, START_ZOOM, TILE_PX, awayWords, geoOf, pointOf, tilesFor, zoomAbout } from "./mapview.js";

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
/** How the pictures are coloured: as they come, or brighter to sit beside the game's own colours. Jason chooses. */
const LOOKS = { plain: "none", bright: "saturate(1.9) contrast(1.06) brightness(1.03)" };
const KEPT = 260; // pictures held at once
const AT_ONCE = 6; // asked for at once

export class WorldMap {
  /**
   * @param {{ panel: HTMLElement, world: import("./world.js").World, player: import("./player.js").Player,
   *   meetup: import("./net.js").Meetup, onOpen: () => void, onClose: () => void,
   *   go: (how: "taxi" | "fly" | "now", place: { name: string, lat: number, lon: number }) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.open = false;
    this.tiles = new Map(); // "z/x/y" -> { picture: ImageBitmap | null, state: "asked" | "here" | "none", used }
    this.asking = 0;
    this.queue = [];
    this.centre = { lat: 0, lon: 0 };
    this.zoom = START_ZOOM;
    this.pick = null; // { lat, lon, name, sub }
    this.drag = null;
    this.look = localStorage.getItem("earthwalk.maplook") === "plain" ? "plain" : "bright";
    this.build();
  }

  build() {
    const p = this.panel;
    p.replaceChildren();
    this.canvas = el("canvas");
    const head = el("div", "head");
    head.append(el("b", "", "The world map"), el("span", "", "Drag to look round  ·  wheel to zoom  ·  click where you want to go  ·  N or Esc to close"));
    const credit = el("div", "credit");
    const link = el("a", "", "OpenStreetMap");
    link.href = "https://www.openstreetmap.org/copyright";
    link.target = "_blank";
    link.rel = "noopener";
    credit.append("© ", link, " contributors");
    const buttons = el("div", "zoom");
    for (const [label, by, title] of [["+", 1, "Closer"], ["−", -1, "Further off"], ["⌖", 0, "Back to where I am"], ["◐", 2, "Brighter colours, or the map as it comes"]]) {
      const b = el("button", "", label);
      b.type = "button";
      b.title = title;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (by === 2) this.setLook(this.look === "plain" ? "bright" : "plain");
        else if (by) this.zoomBy(by, null);
        else this.home();
      });
      buttons.append(b);
    }
    this.card = el("div", "card");
    this.card.hidden = true;
    p.append(this.canvas, head, buttons, credit, this.card);

    const c = this.canvas;
    c.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      this.drag = { x: e.clientX, y: e.clientY, moved: 0, from: pointOf(this.centre.lat, this.centre.lon, this.zoom) };
    });
    addEventListener("mousemove", (e) => {
      const d = this.drag;
      if (!d || !this.open) return;
      d.moved = Math.max(d.moved, Math.hypot(e.clientX - d.x, e.clientY - d.y));
      if (d.moved < 4) return;
      this.centre = geoOf(d.from.x - (e.clientX - d.x), d.from.y - (e.clientY - d.y), this.zoom);
      this.draw();
    });
    addEventListener("mouseup", (e) => {
      const d = this.drag;
      this.drag = null;
      if (!d || !this.open || d.moved >= 4 || e.target !== c) return;
      const box = c.getBoundingClientRect();
      this.choose(this.geoAt(e.clientX - box.left, e.clientY - box.top));
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const box = c.getBoundingClientRect();
      this.zoomBy(e.deltaY < 0 ? 0.5 : -0.5, { x: e.clientX - box.left, y: e.clientY - box.top });
    }, { passive: false });
    addEventListener("resize", () => { if (this.open) this.draw(); });
  }

  toggle() {
    if (this.open) this.close();
    else this.show();
  }

  show() {
    if (this.player.waitingForGround) return;
    this.open = true;
    this.panel.hidden = false;
    document.exitPointerLock?.(); // the mouse is the map's
    this.home();
    this.onOpen();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    this.panel.hidden = true;
    this.drag = null;
    this.onClose();
  }

  /** Where the player is on Earth, and the way they face (radians, clockwise from north). */
  me() {
    const geo = this.world.sceneToGeo(this.player.position);
    return { lat: geo.lat, lon: geo.lon, yaw: -this.player.yaw };
  }

  /** Back to where I am, close enough to see the streets. */
  home() {
    const me = this.me();
    this.centre = { lat: me.lat, lon: me.lon };
    this.zoom = START_ZOOM;
    this.setPick(null);
    this.draw();
  }

  size() {
    const box = this.canvas.getBoundingClientRect();
    return { w: Math.max(1, box.width), h: Math.max(1, box.height) };
  }

  /** The place on Earth under a point of the map, in pixels from its top left corner. */
  geoAt(x, y) {
    const { w, h } = this.size();
    const mid = pointOf(this.centre.lat, this.centre.lon, this.zoom);
    return geoOf(mid.x + x - w / 2, mid.y + y - h / 2, this.zoom);
  }

  /** Where a place on Earth is on the map, in pixels from its top left corner. */
  screenOf(lat, lon) {
    const { w, h } = this.size();
    const mid = pointOf(this.centre.lat, this.centre.lon, this.zoom);
    const at = pointOf(lat, lon, this.zoom);
    return { x: at.x - mid.x + w / 2, y: at.y - mid.y + h / 2 };
  }

  /** Closer (or further off) by so many steps, keeping what is under the pointer where it is. */
  zoomBy(by, about) {
    const { w, h } = this.size();
    const next = zoomAbout(this.centre, this.zoom, by, about ? { x: about.x - w / 2, y: about.y - h / 2 } : { x: 0, y: 0 });
    this.centre = next.centre;
    this.zoom = next.zoom;
    this.draw();
  }

  setLook(name) {
    this.look = name === "plain" ? "plain" : "bright";
    localStorage.setItem("earthwalk.maplook", this.look);
    this.draw();
  }

  // ---------------------------------------------------------------- the pictures

  want(z, x, y) {
    const key = `${z}/${x}/${y}`;
    let tile = this.tiles.get(key);
    if (!tile) {
      tile = { picture: null, state: "asked", used: 0 };
      this.tiles.set(key, tile);
      this.queue.push({ key, z, x, y });
      this.pump();
    }
    tile.used = performance.now();
    return tile;
  }

  pump() {
    while (this.asking < AT_ONCE && this.queue.length) {
      const { key, z, x, y } = this.queue.pop(); // what was asked for last is what is being looked at now
      const tile = this.tiles.get(key);
      if (!tile) continue;
      this.asking++;
      fetch(`/v1/maptile/${z}/${x}/${y}.png`, { headers: this.world.code ? { Authorization: `Bearer ${this.world.code}` } : {} })
        .then((res) => (res.ok ? res.blob() : null))
        .then((blob) => (blob ? createImageBitmap(blob) : null))
        .then((picture) => { tile.picture = picture; tile.state = picture ? "here" : "none"; })
        .catch(() => { tile.state = "none"; })
        .finally(() => {
          this.asking--;
          // A square that could not be had is asked for again when it is next looked at, a little later.
          if (tile.state === "none") setTimeout(() => { if (this.tiles.get(key) === tile) this.tiles.delete(key); }, 8000);
          if (this.open) this.draw();
          this.pump();
        });
    }
    if (this.tiles.size > KEPT) {
      const old = [...this.tiles.entries()].filter(([, t]) => t.state !== "asked").sort((a, b) => a[1].used - b[1].used).slice(0, this.tiles.size - KEPT);
      for (const [key, t] of old) { t.picture?.close?.(); this.tiles.delete(key); }
    }
  }

  // ---------------------------------------------------------------- drawing

  draw() {
    if (!this.open) return;
    const c = this.canvas;
    const { w, h } = this.size();
    const ratio = Math.min(2, devicePixelRatio || 1);
    if (c.width !== Math.round(w * ratio) || c.height !== Math.round(h * ratio)) {
      c.width = Math.round(w * ratio);
      c.height = Math.round(h * ratio);
    }
    const pen = c.getContext("2d");
    pen.setTransform(ratio, 0, 0, ratio, 0, 0);
    pen.fillStyle = "#cfd8dc";
    pen.fillRect(0, 0, w, h);
    pen.filter = LOOKS[this.look];
    pen.imageSmoothingEnabled = true;
    const mid = pointOf(this.centre.lat, this.centre.lon, this.zoom);
    for (const t of tilesFor(mid, this.zoom, w, h)) {
      const tile = this.want(t.z, t.x, t.y);
      const x = t.left - mid.x + w / 2, y = t.top - mid.y + h / 2;
      if (tile.picture) { pen.drawImage(tile.picture, x, y, t.size + 0.5, t.size + 0.5); continue; }
      // Not here yet: the same ground from a picture of further off, if one is held, so the map is never blank for long.
      for (let up = 1; up <= 5 && t.z - up >= 0; up++) {
        const parent = this.tiles.get(`${t.z - up}/${t.x >> up}/${t.y >> up}`);
        if (!parent?.picture) continue;
        const part = TILE_PX / 2 ** up;
        pen.drawImage(parent.picture, (t.x - ((t.x >> up) << up)) * part, (t.y - ((t.y >> up) << up)) * part, part, part, x, y, t.size + 0.5, t.size + 0.5);
        break;
      }
    }
    pen.filter = "none";

    // Friends, then me, then the place chosen.
    pen.font = "600 12px system-ui, sans-serif";
    pen.textAlign = "center";
    for (const peer of this.meetup.peers.values()) {
      if (!peer.hasPosition) continue;
      const at = this.screenOf(peer.lat, peer.lon);
      if (at.x < -40 || at.y < -40 || at.x > w + 40 || at.y > h + 40) continue;
      this.dot(pen, at.x, at.y, 7, "#3fb950");
      this.label(pen, peer.name, at.x, at.y - 13);
    }
    const me = this.me();
    const here = this.screenOf(me.lat, me.lon);
    pen.save();
    pen.translate(here.x, here.y);
    pen.rotate(me.yaw);
    pen.beginPath();
    pen.moveTo(0, -13);
    pen.lineTo(9, 10);
    pen.lineTo(0, 5);
    pen.lineTo(-9, 10);
    pen.closePath();
    pen.fillStyle = "#f5c518";
    pen.strokeStyle = "#26221f";
    pen.lineWidth = 2.5;
    pen.stroke();
    pen.fill();
    pen.restore();
    this.label(pen, "You", here.x, here.y - 18);
    if (this.pick) {
      const at = this.screenOf(this.pick.lat, this.pick.lon);
      pen.beginPath();
      pen.moveTo(at.x, at.y);
      pen.bezierCurveTo(at.x - 16, at.y - 20, at.x - 12, at.y - 36, at.x, at.y - 36);
      pen.bezierCurveTo(at.x + 12, at.y - 36, at.x + 16, at.y - 20, at.x, at.y);
      pen.fillStyle = "#d83a2e";
      pen.strokeStyle = "#26221f";
      pen.lineWidth = 2.5;
      pen.stroke();
      pen.fill();
      this.dot(pen, at.x, at.y - 24, 4.5, "#fff");
    }
  }

  dot(pen, x, y, r, colour) {
    pen.beginPath();
    pen.arc(x, y, r, 0, Math.PI * 2);
    pen.fillStyle = colour;
    pen.strokeStyle = "#26221f";
    pen.lineWidth = 2.5;
    pen.stroke();
    pen.fill();
  }

  label(pen, text, x, y) {
    pen.lineWidth = 4;
    pen.strokeStyle = "rgba(255, 255, 255, .9)";
    pen.strokeText(text, x, y);
    pen.fillStyle = "#26221f";
    pen.fillText(text, x, y);
  }

  // ---------------------------------------------------------------- choosing a place

  /** A place was clicked: it is marked, named (by its neighbourhood: the server tells the place search no more than that), and offered. */
  async choose(geo) {
    const me = this.me();
    const pick = { lat: geo.lat, lon: geo.lon, name: null, away: awayWords(me.lat, me.lon, geo.lat, geo.lon) };
    this.setPick(pick);
    this.draw();
    try {
      const res = await fetch(`/v1/place?lat=${geo.lat.toFixed(2)}&lon=${geo.lon.toFixed(2)}`, { headers: this.world.code ? { Authorization: `Bearer ${this.world.code}` } : {} });
      const found = res.ok ? await res.json() : null;
      if (this.pick !== pick) return; // somewhere else was clicked meanwhile
      pick.name = found?.name ? (found.country && !found.name.includes(found.country) ? `${found.name}, ${found.country}` : found.name) : "";
    } catch {
      if (this.pick !== pick) return;
      pick.name = "";
    }
    this.setPick(pick);
  }

  setPick(pick) {
    this.pick = pick;
    const card = this.card;
    card.hidden = !pick;
    if (!pick) return;
    const title = pick.name === null ? "Looking that up..." : pick.name || "The place you picked";
    card.replaceChildren(el("div", "title", title), el("div", "sub", `${pick.away}. How would you like to get there?`));
    const row = el("div", "row");
    const place = { name: pick.name ? `a spot in ${pick.name}` : "the place you picked", lat: pick.lat, lon: pick.lon };
    for (const [how, label, about] of [["taxi", "Call a taxi", "It comes to you. Hop on (E) and it drives you there."], ["fly", "Fly there", "You are carried there, and watch the world go by."], ["now", "Go there now", "You land there at once."]]) {
      const b = el("button", how === "taxi" ? "main" : "");
      b.type = "button";
      b.append(el("b", "", label), el("span", "", about));
      b.addEventListener("click", () => {
        this.close();
        this.go(how, place);
      });
      row.append(b);
    }
    const no = el("button", "no", "Somewhere else");
    no.type = "button";
    no.addEventListener("click", () => { this.setPick(null); this.draw(); });
    card.append(row, no);
  }
}
