// The progress bar: always on screen while playing, just above the five hearts. It shows my level, its
// name, how far it is to the next, and the nearest next step. When points arrive the bar moves and a little
// note says what earned them ("+3 fed a hungry cow"); a new level gets a small celebration. A click opens
// the passport. The server says all of it (docs/PROTOCOL.md, "Progress"); nothing is worked out here.

import { fillOf, levelUpOf, noteOf, tipOf } from "./progressview.js";

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};
/** How long a note stays, how long a new level is celebrated, and how long the bar takes to fill to the brim before it starts again. */
const NOTE_MS = 3200, NOTE_SHORT_MS = 1500, UP_MS = 5200, BRIM_MS = 650;
const CONFETTI = ["#f2c94c", "#e0352b", "#5fae4e", "#2f6fb0", "#c2507a", "#ffffff"];

export class ProgressBar {
  /**
   * @param {{ bar: HTMLElement, meetup: import("./net.js").Meetup, open?: () => void }} parts
   *   `bar` is the button the bar is drawn in, `open` opens the passport.
   */
  constructor({ bar, meetup, open }) {
    this.bar = bar;
    this.level = null;
    this.queue = []; // news of points earned, shown one at a time
    this.busy = false;
    this.timers = new Set();

    this.badge = el("span", "badge");
    this.title = el("b", "title");
    this.fill = el("i", "fill");
    const track = el("span", "track");
    track.append(this.fill);
    this.hint = el("span", "hint");
    const body = el("span", "body");
    body.append(this.title, track, this.hint);
    this.note = el("span", "note");
    this.note.hidden = true;
    this.party = el("span", "party");
    bar.append(this.badge, body, this.note, this.party);
    bar.setAttribute("aria-live", "polite");
    bar.addEventListener("click", () => { bar.blur(); open?.(); });

    meetup.addEventListener("progress", (e) => this.heard(e.detail));
    // The journal carries the same level: it keeps the bar right after anything that sends one.
    meetup.addEventListener("journal", (e) => { if (e.detail?.level && !this.busy && !this.queue.length) this.show(e.detail.level); });
  }

  /** News from the server: where I stand, or points just earned. */
  heard(news) {
    if (!news?.level || typeof news.level.n !== "number") return;
    if (!(news.gained > 0) || !this.level) return void (this.busy || this.queue.length ? 0 : this.show(news.level));
    this.queue.push(news);
    if (!this.busy) this.next();
  }

  /** Draws a level as it stands, with no fuss. */
  show(level) {
    this.level = level;
    this.bar.hidden = false;
    this.badge.textContent = String(level.n);
    this.title.textContent = level.title;
    this.hint.textContent = level.hint ?? "";
    this.fill.style.width = `${(fillOf(level) * 100).toFixed(1)}%`;
    this.bar.title = tipOf(level);
  }

  after(ms, fn) {
    const t = setTimeout(() => { this.timers.delete(t); fn(); }, ms);
    this.timers.add(t);
  }

  /** The next piece of news waiting: the bar moves, and a note says why. */
  next() {
    const news = this.queue.shift();
    this.busy = !!news;
    if (!news) return;
    const note = noteOf(news);
    const up = levelUpOf(news.up);
    if (note) this.say(note.points, note.text, up ? "" : "gain");
    this.bar.classList.remove("gain");
    void this.bar.offsetWidth; // start the shine again for each
    this.bar.classList.add("gain");
    if (!up) {
      this.show(news.level);
      return this.after(this.queue.length ? NOTE_SHORT_MS : NOTE_MS, () => this.done());
    }
    // A new level: the bar fills to the brim, then starts again on the new level, with a celebration.
    this.fill.style.width = "100%";
    this.after(BRIM_MS, () => {
      this.fill.classList.add("jump");
      this.fill.style.width = "0%";
      void this.fill.offsetWidth;
      this.fill.classList.remove("jump");
      this.show(news.level);
      this.say(up.title, [up.name, up.text].filter(Boolean).join(" · "), "up");
      this.celebrate();
      this.after(UP_MS, () => this.done());
    });
  }

  done() {
    this.note.hidden = true;
    this.bar.classList.remove("gain", "up");
    this.party.replaceChildren();
    this.next();
  }

  /** The little note above the bar. */
  say(head, text, cls) {
    this.note.className = `note ${cls}`;
    this.note.replaceChildren(el("b", "", head), el("span", "", text));
    this.note.hidden = false;
    this.note.style.animation = "none";
    void this.note.offsetWidth; // pop again for each one
    this.note.style.animation = "";
  }

  /** A burst of paper from the badge, and a glow round the bar. */
  celebrate() {
    this.bar.classList.add("up");
    const bits = [];
    for (let i = 0; i < 26; i++) {
      const bit = el("i");
      const turn = (i / 26) * Math.PI * 2 + Math.random() * 0.4;
      const far = 46 + Math.random() * 74;
      bit.style.setProperty("--dx", `${(Math.cos(turn) * far).toFixed(0)}px`);
      bit.style.setProperty("--dy", `${(Math.sin(turn) * far - 46).toFixed(0)}px`);
      bit.style.setProperty("--spin", `${(Math.random() * 720 - 360).toFixed(0)}deg`);
      bit.style.background = CONFETTI[i % CONFETTI.length];
      bit.style.animationDelay = `${(Math.random() * 0.18).toFixed(2)}s`;
      bits.push(bit);
    }
    this.party.replaceChildren(...bits);
  }
}
