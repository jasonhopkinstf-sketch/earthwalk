// The passport: a player's own journal, as the server keeps it (docs/PROTOCOL.md, "Journal"). Where
// they have been, what they have ridden and talked to, the stamps that earns, and a level that rises
// with all of it. P opens and closes it. New stamps pop up for a moment as they are earned.

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
      el("div", "label", news.kind === "country" ? "New country" : news.kind === "level" ? "Level up" : "New stamp"),
      el("div", "title", news.title), el("div", "text", news.text ?? ""));
    this.toast.className = news.kind ?? "stamp";
    this.toast.hidden = false;
    this.toast.style.animation = "none";
    void this.toast.offsetWidth; // start the pop again for each one
    this.toast.style.animation = "";
    setTimeout(() => this.next(), 4200);
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
    page.append(close, head, totals, el("h3", "", "Stamps"), stamps, lists, foot);
    this.panel.replaceChildren(page);
  }
}
