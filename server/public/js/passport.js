// The passport: a player's own journal, as the server keeps it (docs/PROTOCOL.md, "Journal"). Where
// they have been, what they have ridden and talked to, the stamps that earns, and a level that rises
// with all of it. P opens and closes it. New stamps pop up for a moment as they are earned.
// It also has today's three tasks, the coins they pay, and the hats coins buy (docs/PROTOCOL.md,
// "Daily tasks, coins and hats").

import * as THREE from "three";
import { makeAnimal } from "./avatars.js";
import { HAT_IDS, makeHat } from "./hats.js";
import { CALLED } from "./talk.js";

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
const when = (ms) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
const hours = (minutes) => (minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`);
const kind = (sp) => CALLED[sp] ?? sp;
const ONE = { countries: "country", continents: "continent", places: "place", friends: "friend", kinds: "kind" };
const counted = (n, unit) => (unit ? `${n} ${n === 1 ? ONE[unit] ?? unit : unit}` : String(n));

export class Passport {
  /** @param {{ panel: HTMLElement, toast: HTMLElement, meetup: import("./net.js").Meetup }} parts */
  constructor({ panel, toast, meetup }) {
    this.panel = panel;
    this.toast = toast;
    this.meetup = meetup;
    this.queue = [];
    this.showing = false;
    this.pictures = new Map(); // "fox:cap:1" -> a picture of that figure in that hat
    this.studio = null;
    meetup.addEventListener("journal", (e) => { if (!this.panel.hidden) this.draw(e.detail); });
    meetup.addEventListener("stamp", (e) => this.stamp(e.detail));
    panel.addEventListener("click", (e) => { if (e.target === panel || e.target.closest(".close")) this.close(); });
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.open) return this.close();
    this.panel.hidden = false;
    this.panel.replaceChildren(el("div", "page", "Opening your passport..."));
    this.meetup.requestJournal();
  }

  close() {
    this.panel.hidden = true;
  }

  /** A stamp just earned: shown for a few seconds, one at a time. */
  stamp(news) {
    if (typeof news?.title !== "string") return;
    this.queue.push(news);
    if (!this.showing) this.next();
    if (this.open) this.meetup.requestJournal();
  }

  next() {
    const news = this.queue.shift();
    this.showing = !!news;
    if (!news) { this.toast.hidden = true; return; }
    this.toast.replaceChildren(
      el("div", "label", news.kind === "country" ? "New country" : news.kind === "level" ? "Level up" : news.kind === "riddle" ? "Riddles" : news.kind === "task" ? "Today" : news.kind === "prize" ? "A prize" : "New stamp"),
      el("div", "title", news.title), el("div", "text", news.text ?? ""));
    this.toast.className = news.kind ?? "stamp";
    this.toast.hidden = false;
    this.toast.style.animation = "none";
    void this.toast.offsetWidth; // start the pop again for each one
    this.toast.style.animation = "";
    setTimeout(() => this.next(), 4200);
  }

  /** A picture of a player's figure in a hat (or in none): the whole figure, or just its head. Each is made once. */
  picture(avatar, hat, close) {
    const key = `${avatar}:${hat ?? ""}:${close ? 1 : 0}`;
    let url = this.pictures.get(key);
    if (url) return url;
    if (!this.studio) {
      const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
      const scene = new THREE.Scene();
      scene.add(new THREE.HemisphereLight(0xffffff, 0xb0a890, 2.2));
      const sun = new THREE.DirectionalLight(0xffffff, 1.8);
      sun.position.set(-1.5, 3, -3);
      scene.add(sun);
      this.studio = { renderer, scene, camera: new THREE.PerspectiveCamera(30, 1, 0.1, 20) };
    }
    const { renderer, scene, camera } = this.studio;
    const w = close ? 144 : 300, h = close ? 144 : 380;
    const figure = makeAnimal(avatar);
    const worn = hat ? makeHat(hat) : null;
    if (worn) figure.add(worn);
    figure.rotation.y = 0.45; // turned a little, so a hat's shape shows
    scene.add(figure);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    if (close) { camera.position.set(0, 1.66, -1.85); camera.lookAt(0, 1.42, 0); }
    else { camera.position.set(0, 1.25, -4.4); camera.lookAt(0, 0.95, 0); }
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    url = renderer.domElement.toDataURL("image/png");
    scene.remove(figure);
    this.pictures.set(key, url);
    return url;
  }

  draw(j) {
    const page = el("div", "page");
    if (!j) {
      page.append(el("h2", "", "Passport"), el("p", "", "This server is not keeping journals."));
      return this.panel.replaceChildren(page);
    }
    const close = el("button", "close", "Close (P)");
    close.type = "button";
    const span = Math.max(1, j.level.next - j.level.from);
    const bar = el("div", "bar");
    const fill = el("div", "fill");
    fill.style.width = `${Math.min(100, Math.round(((j.level.points - j.level.from) / span) * 100))}%`;
    bar.append(fill);
    const head = el("div", "head");
    head.append(el("div", "level", `Level ${j.level.n}`), el("h2", "", j.level.title), bar,
      el("div", "small", `${j.level.points} points · ${j.level.next - j.level.points} more to level ${j.level.n + 1}`));

    const totals = el("div", "totals");
    const total = (n, label) => { const t = el("div", "total"); t.append(el("b", "", String(n)), el("span", "", label)); totals.append(t); };
    total(j.totals.countries, j.totals.countries === 1 ? "country" : "countries");
    total(j.totals.continents, j.totals.continents === 1 ? "continent" : "continents");
    total(j.totals.places, j.totals.places === 1 ? "place" : "places");
    total(j.totals.km, "km on foot");
    total(j.totals.kmRidden, "km ridden");
    total(j.totals.friends, j.totals.friends === 1 ? "friend made" : "friends made");

    const stamps = el("div", "stamps");
    for (const s of j.stamps) {
      const card = el("div", s.done ? "stamp done" : "stamp");
      const single = s.steps.length === 1;
      card.append(el("div", "name", s.title),
        el("div", "count", single ? (s.done ? "Done" : "Not yet") : counted(s.have, s.unit)),
        el("div", "small", single ? "" : s.next === null ? "All stamps earned" : `Next stamp at ${s.next}`));
      if (!single) {
        const pips = el("div", "pips");
        s.steps.forEach((step, i) => pips.append(el("i", i < s.done ? "on" : "", String(step))));
        card.append(pips);
      }
      stamps.append(card);
    }

    const lists = el("div", "lists");
    const list = (title, rows, empty) => {
      const box = el("div", "list");
      box.append(el("h3", "", title));
      if (!rows.length) box.append(el("p", "small", empty));
      for (const [main, side] of rows) { const row = el("div", "row"); row.append(el("span", "", main), el("span", "small", side)); box.append(row); }
      lists.append(box);
    };
    list("Countries", j.countries.map((c) => [c.name, when(c.first)]), "Walk somewhere and it will be stamped here.");
    list("Lately", j.places.map((p) => [p.name, p.country ?? ""]), "Nowhere yet.");
    list("Friends", j.friends.map((f) => [`${f.name} the ${kind(f.sp)}`, f.times > 1 ? `${f.times} chats` : ""]), "Press T beside an animal, a tree or a car to make one.");
    list("Ridden", j.riddenKinds.map((sp) => [kind(sp), ""]), "Press E beside a horse, a car or a train.");

    const foot = el("p", "small foot", j.kept
      ? `Yours alone: nobody else can open your passport. Kept since ${when(j.since)} · ${j.totals.visits} visits · ${hours(j.totals.minutes)} in the world.`
      : "You are a guest, so this passport lasts only for this visit. Sign in with Google to keep one.");
    // Riddles: those unlocked so far, each with its answer once it is found.
    const riddles = el("div", "riddles");
    for (const r of j.riddles ?? []) {
      const card = el("div", r.solved ? "riddle solved" : "riddle");
      card.append(el("div", "text", r.text), el("div", "small", r.solved ? `Solved: it was ${r.answer}.` : "Find the answer in the world, and talk to it or ride it."));
      riddles.append(card);
    }
    if (j.moreRiddles) riddles.append(el("p", "small", `${j.moreRiddles.count} more ${j.moreRiddles.count === 1 ? "riddle" : "riddles"} at level ${j.moreRiddles.level}.`));

    // Companions: the answers of solved riddles, any one of which will follow you about.
    const pets = el("div", "pets");
    const choice = (label, sp) => {
      const b = el("button", (j.pet ?? null) === sp ? "pet on" : "pet", label);
      b.type = "button";
      b.addEventListener("click", () => { this.meetup.sendPet(sp); this.meetup.requestJournal(); });
      pets.append(b);
    };
    if ((j.pets ?? []).length) {
      choice("Nobody", null);
      for (const sp of j.pets) choice(kind(sp), sp);
    } else pets.append(el("p", "small", "Solve a riddle and its answer will keep you company."));

    // Today: three tasks, the same for everyone whose day it is.
    const coins = el("div", "coins", `${j.coins ?? 0} coins`);
    const tasks = el("div", "tasks");
    for (const t of j.today?.tasks ?? []) {
      const card = el("div", t.done ? "task done" : "task");
      const bar = el("div", "bar");
      const fill = el("div", "fill");
      fill.style.width = `${Math.round((t.have / t.goal) * 100)}%`;
      bar.append(fill);
      card.append(el("div", "text", t.text), bar,
        el("div", "small", t.done ? `Done: ${j.today.coinsEach} coins` : t.goal > 1 ? `${t.have} of ${t.goal}${t.unit === "m" ? " m" : ""}` : "Not yet"));
      tasks.append(card);
    }
    const days = j.today?.fullDays ?? 0;
    const tasksNote = el("p", "small", j.today?.all
      ? `All three done today. There will be three new tasks tomorrow. Full days so far: ${days}.`
      : `Each task pays ${j.today?.coinsEach} coins, and doing all three pays ${j.today?.coinsAll} more. Nothing runs out: tomorrow simply brings three new ones.${days ? ` Full days so far: ${days}.` : ""}`);

    // Hats: bought with coins or won, one worn at a time. Friends see it on you.
    const avatar = this.meetup.me?.avatar ?? "fox";
    const wardrobe = el("div", "wardrobe");
    const me = document.createElement("img");
    me.className = "me";
    me.alt = j.hat ? "You, in your hat" : "You, bareheaded";
    me.src = this.picture(avatar, j.hat ?? null, false);
    const hats = el("div", "hats");
    const hatCard = (hat, name, note, cls, disabled, act) => {
      const b = el("button", cls);
      b.type = "button";
      b.disabled = disabled;
      const img = document.createElement("img");
      img.alt = "";
      img.src = this.picture(avatar, hat, true);
      b.append(img, el("b", "", name), el("span", "small", note));
      b.addEventListener("click", () => { act(); this.meetup.requestJournal(); });
      hats.append(b);
    };
    hatCard(null, "No hat", j.hat ? "Take it off" : "As you are", j.hat ? "hat owned" : "hat on", false, () => this.meetup.wearHat(null));
    for (const h of j.hats ?? []) {
      if (!HAT_IDS.includes(h.id)) continue; // a hat this game cannot draw yet
      const wearing = j.hat === h.id;
      const canBuy = !h.owned && h.price !== null && (j.coins ?? 0) >= h.price;
      hatCard(h.id, h.name,
        wearing ? "You are wearing it" : h.owned ? "Yours: put it on" : h.price !== null ? (canBuy ? `Buy for ${h.price} coins` : `${h.price} coins`) : `A prize. ${h.how}`,
        wearing ? "hat on" : h.owned ? "hat owned" : "hat", !h.owned && !canBuy,
        () => (h.owned ? this.meetup.wearHat(h.id) : this.meetup.buyHat(h.id)));
    }
    wardrobe.append(me, hats);

    page.append(close, coins, head, totals, el("h3", "", "Today"), tasks, tasksNote, el("h3", "", "Hats"), wardrobe,
      el("h3", "", "Riddles"), riddles, el("h3", "", "Companions"), pets, el("h3", "", "Stamps"), stamps, lists, foot);
    this.panel.replaceChildren(page);
  }
}
