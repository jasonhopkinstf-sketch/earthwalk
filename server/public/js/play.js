// Tag, and hide and seek (docs/PROTOCOL.md, "Tag, and hide and seek"). The server judges who has been
// touched or found; here the field is marked out with flags, an arrow hangs over whoever is "it" (or
// seeking), the seeker sees nothing while the others hide, and a small panel says how things stand.
// R joins a game that is set up and starts your own; /tag and /hide set one up.

import * as THREE from "three";

const box = new THREE.BoxGeometry(1, 1, 1);
const cone = new THREE.ConeGeometry(1, 1, 12);
const POLE = new THREE.MeshLambertMaterial({ color: 0xf4f1ea });
const FLAG = new THREE.MeshLambertMaterial({ color: 0xf08a3c });
const ARROW = new THREE.MeshBasicMaterial({ color: 0xe0352b });
const FLAGS = 28;
const NAMES = { tag: "tag", hide: "hide and seek" };

const mmss = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

export class Play {
  /**
   * @param {{ scene: THREE.Scene, world: import("./world.js").World, meetup: import("./net.js").Meetup,
   *   player: import("./player.js").Player, avatars: import("./avatars.js").Avatars, panel: HTMLElement,
   *   banner: HTMLElement, blind: HTMLElement, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.field = null; // the ring of flags
    this.flags = [];
    this.course = "";
    this.before = null; // what I last knew of the game, to say what is new
    this.arrow = new THREE.Mesh(cone, ARROW);
    this.arrow.scale.set(0.28, 0.6, 0.28);
    this.arrow.rotation.x = Math.PI; // point down
    this.arrow.visible = false;
    this.scene.add(this.arrow);
    this.meetup.addEventListener("play", () => this.heard());
  }

  get play() {
    return this.meetup.play;
  }

  nameOf(id) {
    return this.play?.players.find((p) => p.id === id)?.name ?? "Somebody";
  }

  /** The game has changed: mark out the field if it is a new one, and say what has happened. */
  heard() {
    const play = this.play;
    const me = this.meetup.me?.id;
    const key = play ? `${play.by}:${play.made}` : "";
    if (key !== this.course) {
      this.course = key;
      if (this.field) this.scene.remove(this.field);
      this.field = null;
      this.flags = [];
      this.before = null;
      if (play) {
        this.field = new THREE.Group();
        for (let i = 0; i < FLAGS; i++) {
          const flag = new THREE.Group();
          const pole = new THREE.Mesh(box, POLE);
          pole.scale.set(0.08, 2.4, 0.08);
          pole.position.y = 1.2;
          const cloth = new THREE.Mesh(box, FLAG);
          cloth.scale.set(0.7, 0.42, 0.04);
          cloth.position.set(0.39, 2.15, 0);
          flag.add(pole, cloth);
          flag.visible = false;
          this.flags.push(flag);
          this.field.add(flag);
        }
        this.scene.add(this.field);
        this.say(play.by === me ? `Your game of ${NAMES[play.kind]} is set up, inside the ring of orange flags. Press R to start once a friend has joined.`
          : `${play.byName} has set up a game of ${NAMES[play.kind]}. Press R to join in.`);
      }
    }
    const was = this.before;
    if (play && was) {
      if (was.state === "open" && play.state === "go") {
        this.say(play.kind === "tag" ? (play.it === me ? "You are it! Touch somebody to pass it on." : `${this.nameOf(play.it)} is it. Keep away!`)
          : play.it === me ? "You are the seeker. Wait while they hide, then go and find them." : `${this.nameOf(play.it)} is the seeker. Hide, inside the ring of flags!`);
      } else if (play.kind === "tag" && play.state === "go" && was.it !== play.it) {
        this.say(play.it === me ? "You are it!" : `${this.nameOf(play.it)} is it.`);
      }
      if (play.kind === "hide") {
        for (const p of play.players) {
          if (p.found && !was.found.has(p.id)) this.say(p.id === me ? "You have been found!" : `${p.name} has been found.`);
        }
      }
    }
    this.before = play ? { state: play.state, it: play.it, found: new Set(play.players.filter((p) => p.found).map((p) => p.id)) } : null;
    this.told = null;
  }

  /** Sets a game up where I stand: "tag" or "hide". */
  make(kind) {
    if (!this.meetup.joined) return;
    this.say(`Setting up a game of ${NAMES[kind]} here...`);
    this.meetup.sendPlay({ make: kind });
  }

  /** The R key. True when there is a game for it to act on (so that it does not also set up a race). */
  key() {
    const { play, meetup } = this;
    if (!play || play.state === "over") return false;
    if (play.state !== "open") return true;
    if (!play.players.some((p) => p.id === meetup.me?.id)) meetup.sendPlay({ join: true });
    else if (play.by === meetup.me?.id) meetup.sendPlay({ go: true });
    else this.say(`You are in. ${play.byName} says when to start.`);
    return true;
  }

  stop() {
    if (this.play) this.meetup.sendPlay({ stop: true });
    else this.say("There is no game just now.");
  }

  /** Every frame. `t` is the shared clock in seconds. */
  frame(t) {
    const { play, world, meetup, player, avatars } = this;
    const mine = meetup.me?.id;
    const now = t * 1000;
    const me = play?.players.find((p) => p.id === mine) ?? null;
    const live = !!play && play.state === "go" && now >= play.startAt;
    const seeking = live && play.kind === "hide" && now >= play.seekAt;

    // Whoever is it runs a little faster than the rest, or nobody would ever be caught.
    player.boost = live && play.kind === "tag" && play.it === mine ? 1.2 : 1;
    if (live && me && player.flying) player.setFlying(false); // feet on the ground while playing

    // Names hang over everyone so that friends can find each other: not over those the seeker is looking for.
    for (const [id, shown] of avatars.shown) {
      const hider = play?.players.find((p) => p.id === id);
      shown.label.visible = !(live && play.kind === "hide" && play.it === mine && hider && !hider.found);
    }

    // The seeker sees nothing while the others hide.
    const counting = !!play && play.state === "go" && play.kind === "hide" && play.it === mine && now >= play.startAt && now < play.seekAt;
    if (this.blind.hidden === counting) this.blind.hidden = !counting;
    if (counting) {
      const text = `No peeking! They are hiding... ${Math.ceil((play.seekAt - now) / 1000)}`;
      if (this.blind.textContent !== text) this.blind.textContent = text;
    }

    if (!play) {
      this.arrow.visible = false;
      if (!this.panel.hidden) { this.panel.hidden = true; this.banner.hidden = true; }
      return;
    }

    // The ring of flags, each stood on the ground once the ground there has arrived.
    const centre = world.geoToScene(play.lat, play.lon);
    this.flags.forEach((flag, i) => {
      if (flag.visible) return;
      const a = (i / FLAGS) * Math.PI * 2;
      const x = centre.x + Math.sin(a) * play.radius, z = centre.z + Math.cos(a) * play.radius;
      const y = world.groundHeight(x, z);
      if (y === null) return;
      flag.position.set(x, y, z);
      flag.rotation.y = a;
      flag.visible = true;
    });

    // An arrow over whoever is it, or seeking, when that is somebody else.
    const shown = live && play.it && play.it !== mine ? avatars.shown.get(play.it) : null;
    this.arrow.visible = !!shown;
    if (shown) this.arrow.position.set(shown.group.position.x, shown.group.position.y + 2.7 + Math.sin(t * 4) * 0.12, shown.group.position.z);

    // The countdown to the start.
    const until = play.state === "go" ? play.startAt - now : null;
    const count = until === null ? "" : until > 0 ? String(Math.ceil(until / 1000)) : until > -1200 ? "GO!" : "";
    if (this.banner.textContent !== count) this.banner.textContent = count;
    this.banner.hidden = !count;

    // The panel.
    const lines = [];
    const out = !!me && live && Math.hypot(player.position.x - centre.x, player.position.z - centre.z) > play.radius;
    if (play.state === "open") {
      lines.push(`${play.kind === "tag" ? "Tag" : "Hide and seek"}, set up by ${play.byName}`, `In: ${play.players.map((p) => p.name).join(", ")}`,
        !me ? "R: join in" : play.by === mine ? (play.players.length < 2 ? "Waiting for a friend to join" : "R: start the game") : `Waiting for ${play.byName} to start`);
    } else if (play.state === "go" && !live) {
      lines.push("Get ready...");
    } else if (play.kind === "tag") {
      if (play.state === "go") lines.push(play.it === mine ? "You are IT: touch somebody!" : `${this.nameOf(play.it)} is it: keep away!`, `${mmss(play.endAt - now)} left`);
      else lines.push("Tag is over");
      for (const p of [...play.players].sort((a, b) => a.itMs - b.itMs)) {
        const ms = p.itMs + (play.state === "go" && p.id === play.it ? Math.max(0, now - play.since) : 0);
        lines.push(`${p.name}: it for ${Math.round(ms / 1000)} s`);
      }
    } else {
      const hiders = play.players.filter((p) => p.id !== play.it);
      const hidden = hiders.filter((p) => !p.found);
      if (play.state === "over") lines.push("Hide and seek is over", hidden.length ? `Never found: ${hidden.map((p) => p.name).join(", ")}` : `${this.nameOf(play.it)} found everyone`);
      else if (!seeking) lines.push(play.it === mine ? "Wait while they hide" : `Hide! ${this.nameOf(play.it)} comes looking in ${Math.ceil((play.seekAt - now) / 1000)} s`);
      else {
        lines.push(play.it === mine ? `Find them: ${hidden.length} still hidden` : me?.found ? "You were found. Watch the rest!" : "Stay hidden!", `${mmss(play.endAt - now)} left`);
        for (const p of hiders) lines.push(`${p.name}: ${p.found ? "found" : "hiding"}`);
      }
    }
    if (out && play.state === "go") lines.unshift("Back inside the flags!");
    if (play.state === "over") lines.push("/tag or /hide for another");
    const text = lines.join("\n");
    if (text !== this.told) { this.told = text; this.panel.textContent = text; }
    this.panel.hidden = false;
  }
}
