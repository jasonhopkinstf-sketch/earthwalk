// "Show me...": a list of things the world can do, for showing it to somebody. Choosing one puts the
// player right beside the thing itself: where the train is about to stop, next to a horse, at a
// parked car, in front of a door that opens.
//
// The list comes from the server (/v1/showcase), each entry with a real place where the thing is to
// be found. If one is already near the player it is used; otherwise the player travels to the place,
// and is stood beside the thing once the world there has arrived.

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const rad = (degrees) => (degrees * Math.PI) / 180;

/** A thing this near is used where it is; further off, the show's own place is travelled to. */
const NEAR_M = 500;
/** After arriving at a show's place, how far from it to look, and how long to wait for the world to fill in. */
const AT_PLACE_M = 900;
const WAIT_MS = 25000;
/** Nobody showing the world to a friend wants to stand by an empty track: a train further off than this many seconds is gone to instead. */
const TRAIN_SOON_S = 30;

export class Showcase {
  /**
   * @param {{ panel: HTMLElement, world: import("./world.js").World, player: import("./player.js").Player,
   *   life: import("./life.js").Life, traffic: import("./traffic.js").Traffic, riding: import("./riding.js").Riding,
   *   meetup: import("./net.js").Meetup, say: (text: string) => void, problem: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.shows = null; // the list, once asked for
    this.pending = null; // a show travelled to, waiting for the world there: { show, since }
    this.snap = null; // an animal to be put within reach of, once it is drawn: { sp, at }
    this.panel.addEventListener("click", (e) => {
      const card = e.target.closest("[data-show]");
      if (card) this.go(card.dataset.show);
      else if (e.target === this.panel || e.target.closest(".close")) this.close();
    });
  }

  get open() {
    return !this.panel.hidden;
  }

  close() {
    this.panel.hidden = true;
  }

  async load() {
    if (this.shows) return this.shows;
    const res = await fetch("/v1/showcase", { headers: this.world.code ? { Authorization: `Bearer ${this.world.code}` } : {} });
    if (!res.ok) throw new Error(`showcase ${res.status}`);
    const list = (await res.json()).shows;
    this.shows = Array.isArray(list) ? list.filter((s) => s && typeof s.id === "string" && s.place && Number.isFinite(s.place.lat) && Number.isFinite(s.place.lon)) : [];
    return this.shows;
  }

  /** G: the list, or away with it. */
  async toggle() {
    if (this.open) return this.close();
    document.exitPointerLock?.(); // the mouse is needed for choosing
    this.panel.hidden = false;
    this.panel.replaceChildren(el("div", "page", "Looking for things to show..."));
    try {
      this.draw(await this.load());
    } catch {
      this.panel.replaceChildren(el("div", "page", "The world server is not answering just now. Press G to try again."));
    }
  }

  draw(shows) {
    const page = el("div", "page");
    page.append(el("button", "close", "Close (Esc)"), el("h2", "", "Show me..."), el("p", "lead", "Pick one, and you are taken straight to it. Click it, or press its number."));
    const list = el("div", "cards");
    shows.forEach((show, i) => {
      const card = el("button", "card");
      card.dataset.show = show.id;
      card.append(el("span", "key", i < 9 ? String(i + 1) : i === 9 ? "0" : ""), el("b", "", show.title), el("span", "text", show.text), el("span", "place", show.place.name));
      list.append(card);
    });
    page.append(list);
    this.panel.replaceChildren(page);
  }

  /** A number key while the list is open: 1 to 9, then 0 for the tenth. True if it chose something. */
  key(code) {
    if (!this.open || !this.shows) return false;
    const digit = /^(?:Digit|Numpad)(\d)$/.exec(code)?.[1];
    if (digit === undefined) return false;
    const show = this.shows[digit === "0" ? 9 : Number(digit) - 1];
    if (show) this.go(show.id);
    return !!show;
  }

  /** Takes the player to a show: by its id, or by words out of its title ("/show train"). */
  async go(what) {
    let shows;
    try {
      shows = await this.load();
    } catch {
      return this.problem("The world server is not answering just now. Try again in a moment.");
    }
    const asked = String(what).trim().toLowerCase();
    const show = shows.find((s) => s.id === asked) ?? shows.find((s) => s.title.toLowerCase().includes(asked));
    if (!show) return this.problem(`There is nothing called "${what}" to show. Press G for the list.`);
    this.close();
    const p = this.player;
    if (p.waitingForGround) return this.problem("Wait until you have landed, then try again.");
    if (this.riding.mine) this.riding.off();
    if (p.flying) p.setFlying(false);
    this.snap = null;
    const spot = show.find === "air" ? null : this.look(show, p.position, NEAR_M);
    if (spot && !(show.find === "train" && spot.in > TRAIN_SOON_S)) {
      this.pending = null;
      this.stand(show, spot);
      return;
    }
    this.say(`${show.title}: going to ${show.place.name}...`);
    p.travelTo(show.place.lat, show.place.lon);
    this.pending = { show, since: 0 };
  }

  /**
   * The nearest thing of the show's kind to `from`, within `within` metres, in what this game has loaded.
   * Trains are chosen by how soon one will be standing still.
   */
  look(show, from, within) {
    const { world } = this;
    const S = world.tileM;
    let best = null;
    const consider = (x, z, more, rank) => {
      const d = Math.hypot(x - from.x, z - from.z);
      if (d > within) return;
      const score = rank ?? d;
      if (!best || score < best.score) best = { x, z, score, ...more };
    };
    if (show.find === "train") {
      // The trains are counted afresh first: just after a journey, the last place's are still on the books.
      this.traffic.sync(this.player.position);
      // A train standing still is easiest to board, so one of those is worth waiting a little longer for.
      for (const stop of this.traffic.boarding(this.meetup.now(), from, within)) consider(stop.x, stop.z, stop, stop.in + (stop.passing ? 25 : 0));
      return best;
    }
    const taken = this.riding.hidden;
    for (const chunk of world.chunks.values()) {
      const ox = (chunk.x - world.originX) * S;
      const oz = (chunk.y - world.originY) * S;
      const items = show.find === "home" ? chunk.homes : show.find === "car" ? chunk.cars : show.find === "door" ? chunk.doors : null;
      for (const it of items ?? []) {
        if (![it.u, it.v].every(Number.isFinite)) continue;
        if (show.find === "home" && !(show.sp ?? []).includes(it.sp)) continue;
        if (show.find === "car" && taken.has(it.id >>> 0)) continue; // somebody has driven it off
        consider(ox + it.u * S, oz + it.v * S, { sp: it.sp, r: Number.isFinite(it.r) ? it.r : 4, yaw: Number.isFinite(it.yaw) ? it.yaw : 0 });
      }
    }
    return best;
  }

  /** Puts the player on the ground at a spot, looking at something. False where the ground is not there yet. */
  put(x, z, lookX, lookZ) {
    const ground = this.world.groundHeight(x, z);
    if (ground === null) return false;
    const p = this.player;
    p.position.set(x, ground, z);
    p.velocityY = 0;
    p.grounded = true;
    p.yaw = Math.atan2(lookX - x, -(lookZ - z));
    p.pitch = 0;
    return true;
  }

  stand(show, spot) {
    const p = this.player;
    let x = spot.x, z = spot.z;
    let extra = "";
    if (show.find === "train") {
      // Beside the track, on the side the player is already on.
      const h = rad(spot.heading);
      const side = (p.position.x - spot.x) * Math.cos(h) + (p.position.z - spot.z) * Math.sin(h) < 0 ? -1 : 1;
      // A standing train can be looked at from a few steps back; a passing one must be within reach as it goes by.
      const back = spot.passing ? 5.5 : 7;
      x += Math.cos(h) * back * side;
      z += Math.sin(h) * back * side;
      const soon = spot.in < 50 ? `about ${Math.max(5, Math.round(spot.in / 5) * 5)} seconds` : spot.in < 100 ? "about a minute" : `about ${Math.round(spot.in / 60)} minutes`;
      extra = spot.passing ? ` A train comes past here in ${soon} without stopping: press E as it goes by to jump on.`
        : spot.in < 3 ? " The train is standing right here." : ` The train draws in here in ${soon}.`;
    } else if (show.find === "home") {
      // Just outside the ground the animals roam on, on the side the player came from (the south, failing that).
      let dx = p.position.x - spot.x, dz = p.position.z - spot.z;
      const d = Math.hypot(dx, dz);
      if (d < 1 || d > NEAR_M) { dx = 0; dz = 1; } else { dx /= d; dz /= d; }
      const out = show.ride ? Math.min(spot.r, 6) : spot.r + 3;
      x += dx * out;
      z += dz * out;
      if (show.ride) this.snap = { sp: show.sp ?? [], at: performance.now() + 700, until: performance.now() + 6000 };
    } else if (show.find === "car") {
      const h = rad(spot.yaw); // beside the driver's door, more or less
      x += Math.cos(h) * 3.1;
      z += Math.sin(h) * 3.1;
    } else if (show.find === "door") {
      const h = rad(spot.yaw); // the way out of the door: stand on the path, within reach of the handle
      x += Math.sin(h) * 1.9;
      z -= Math.cos(h) * 1.9;
    }
    if (!this.put(x, z, spot.x, spot.z)) this.put(spot.x, spot.z, spot.x, spot.z - 1);
    this.say(`${show.title}. ${show.how}${extra}`);
  }

  /** Every frame. */
  frame() {
    const p = this.player;
    const w = this.pending;
    if (w && !p.waitingForGround) {
      const now = performance.now();
      if (!w.since) w.since = now; // landed
      if (w.show.find === "air") {
        this.pending = null;
        p.setFlying(true);
        p.position.y += 170;
        p.pitch = -0.45;
        if (Number.isFinite(w.show.yaw)) p.yaw = (-w.show.yaw * Math.PI) / 180; // facing what is shown
        this.say(`${w.show.title}. ${w.show.how}`);
      } else {
        // The animals, cars, doors and trains come a moment after the ground does.
        const { cx, cy } = this.world.chunkAt(p.position.x, p.position.z);
        const filled = this.world.chunks.get(`${cx}/${cy}`)?.trees === true;
        const spot = filled ? this.look(w.show, { x: 0, z: 0 }, w.hopped ? 400 : AT_PLACE_M) : null;
        // No train due here for a while: go along the line to where one is, once, and catch it there.
        const far = filled && w.show.find === "train" && !w.hopped && !(spot && spot.in <= TRAIN_SOON_S)
          ? this.traffic.soonest(this.meetup.now()).sort((a, b) => a.in + (a.passing ? 10 : 0) - b.in - (b.passing ? 10 : 0))[0] : null;
        if (far) {
          const geo = this.world.sceneToGeo({ x: far.x, y: 0, z: far.z });
          w.hopped = true;
          w.since = 0;
          p.travelTo(geo.lat, geo.lon);
        } else if (spot && (w.show.find !== "train" || spot.in <= TRAIN_SOON_S || w.hopped || now - w.since > 3000)) {
          this.pending = null;
          this.stand(w.show, spot);
        } else if (now - w.since > WAIT_MS) {
          this.pending = null;
          this.say(`You are at ${w.show.place.name}. ${w.show.text} Have a look round. ${w.show.how}`);
        }
      }
    }
    // Something to ride: once the animals here are being drawn, stand within reach of the nearest.
    const s = this.snap;
    if (s && performance.now() > s.at) {
      let best = null;
      for (const c of this.life.rideable) {
        if (!s.sp.includes(c.sp)) continue;
        const d = Math.hypot(c.x - p.position.x, c.z - p.position.z);
        if (!best || d < best.d) best = { ...c, d };
      }
      if (best) {
        this.snap = null;
        if (best.d > 2.5) {
          const dx = (p.position.x - best.x) / best.d, dz = (p.position.z - best.z) / best.d;
          const gap = ["tractor", "boat", "sailboat"].includes(best.sp) ? 2.7 : 2.2; // a little room for the big ones
          this.put(best.x + dx * gap, best.z + dz * gap, best.x, best.z);
        }
      } else if (performance.now() > s.until) this.snap = null;
    }
  }
}
