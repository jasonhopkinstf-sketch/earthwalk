// Teaching a companion tricks (the K key). The panel lists the tricks there are: those the animal at my
// side knows, each with a button to have it do one, and the next it could learn. A lesson is a small game
// of timing: paw prints run along a bar towards a ring, and Space is pressed as each one reaches it. The
// server sets the beats and marks the presses (docs/PROTOCOL.md, "Tricks"); one slip is forgiven, and a
// lesson that does not come off is simply had again.

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
/** Where the ring is on the bar, and how fast the paw prints run towards it, in pixels a millisecond. */
const RING_PX = 56;
const RUN = 0.17;
/** How long after the last beat the lesson is handed in. */
const AFTER_MS = 700;

export class Train {
  /**
   * @param {{ panel: HTMLElement, bar: HTMLElement, meetup: import("./net.js").Meetup,
   *   player: import("./player.js").Player, agility: () => void, say: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.journal = null;
    this.lesson = null; // the lesson under way: { name, beats, slack, t0, presses, marks, dots }
    const { meetup } = this;
    meetup.addEventListener("journal", (e) => { this.journal = e.detail; if (this.open) this.draw(); });
    meetup.addEventListener("pet", (e) => { if (e.detail.id === meetup.me?.id && this.open) meetup.requestJournal(); });
    meetup.addEventListener("lesson", (e) => (e.detail.done ? this.marked(e.detail) : this.begin(e.detail)));
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.open) return this.close();
    this.panel.hidden = false;
    document.exitPointerLock?.();
    this.meetup.requestJournal();
    this.draw();
  }

  close() {
    this.panel.hidden = true;
  }

  /** The tricks my companion knows, in order: the number keys do them while the panel is open. */
  known() {
    return (this.journal?.tricks?.all ?? []).filter((t) => t.known);
  }

  /** Has it do a trick: by its name or its place among those it knows. */
  perform(which) {
    const known = this.known();
    const trick = typeof which === "number" ? known[which] : known.find((t) => t.id === which || t.name.toLowerCase() === String(which).toLowerCase());
    if (!trick) return false;
    this.meetup.sendTrick({ do: trick.id });
    return true;
  }

  /** Begins a lesson in the next trick. */
  teach() {
    const next = this.journal?.tricks?.next;
    if (this.lesson) return;
    if (!this.journal?.tricks?.pet) return this.say("You have no companion with you. Solve a riddle to win one, and choose it in your passport (P).");
    if (!next) return this.say("Your companion knows every trick there is.");
    this.meetup.sendTrick({ learn: next });
  }

  /** The server has set a lesson: the paw prints start running. */
  begin(set) {
    this.close();
    const track = el("div", "track");
    track.append(el("div", "ring"));
    const dots = set.beats.map(() => {
      const d = el("div", "paw", "🐾");
      track.append(d);
      return d;
    });
    this.bar.replaceChildren(el("div", "title", `Teaching: ${set.name}`), track, el("div", "small", "Press Space each time a paw print reaches the ring"));
    this.bar.hidden = false;
    this.lesson = { name: set.name, beats: set.beats, slack: set.slack, t0: performance.now(), presses: [], marks: set.beats.map(() => ""), dots };
    this.player.typing = true; // standing still, and Space is for the lesson
    this.player.keys.clear();
    this.frame();
  }

  /** Space, during a lesson. Returns whether a lesson took it. */
  press() {
    const l = this.lesson;
    if (!l) return false;
    const at = performance.now() - l.t0;
    l.presses.push(Math.round(at));
    // Show at once whether it was on a beat (the server has the last word).
    const k = l.beats.findIndex((b, i) => !l.marks[i] && Math.abs(b - at) <= l.slack);
    if (k >= 0) l.marks[k] = "hit";
    this.bar.classList.toggle("flash", true);
    setTimeout(() => this.bar.classList.toggle("flash", false), 120);
    return true;
  }

  /** Every frame while a lesson runs. */
  frame() {
    const l = this.lesson;
    if (!l) return;
    const at = performance.now() - l.t0;
    l.beats.forEach((b, i) => {
      if (!l.marks[i] && at > b + l.slack) l.marks[i] = "miss";
      l.dots[i].style.transform = `translateX(${RING_PX + (b - at) * RUN}px)`;
      l.dots[i].className = `paw ${l.marks[i]}`;
    });
    if (at > l.beats[l.beats.length - 1] + AFTER_MS) {
      this.meetup.sendTrick({ presses: l.presses });
      this.lesson = null;
      this.player.typing = false;
      this.bar.lastElementChild.textContent = "Let us see how that went...";
    }
  }

  /** The server's marks. */
  marked(result) {
    this.lesson = null;
    this.player.typing = false;
    this.bar.hidden = true;
    if (result.passed) this.say(`${result.name}: ${result.hits} of ${result.of} on the beat. Learnt! Press K and it will do it whenever you like.`);
    else this.say(`${result.name}: ${result.hits} of ${result.of} on the beat. Nearly! Press K and teach it again: nothing is lost.`);
    this.meetup.requestJournal();
  }

  draw() {
    const box = el("div", "page");
    const close = el("button", "close", "×");
    close.type = "button";
    close.title = "Close (K)";
    close.addEventListener("click", () => this.close());
    box.append(close, el("h2", "", "Tricks"));
    const t = this.journal?.tricks;
    if (!t) {
      box.append(el("p", "small", "One moment..."));
      return void this.panel.replaceChildren(box);
    }
    if (!t.pet) {
      box.append(el("p", "small", "You have no companion with you. Solve a riddle (P, Riddles) to win an animal that follows you about, and choose it under Companions. Then it can learn tricks."));
      return void this.panel.replaceChildren(box);
    }
    const known = t.all.filter((x) => x.known);
    box.append(el("p", "small", `Your ${t.pet} knows ${known.length} of ${t.all.length} tricks. Friends nearby see it do them.`));
    const list = el("div", "tricks");
    let n = 0;
    for (const trick of t.all) {
      const mine = trick.known;
      const next = trick.id === t.next;
      const b = el("button", mine ? "trick known" : next ? "trick next" : "trick");
      b.type = "button";
      b.disabled = !mine && !next;
      const key = mine ? ++n : 0;
      b.append(el("b", "", trick.name), el("span", "small", mine ? `Do it (${key})` : next ? `Teach it · ${t.coins} coins` : "Later"));
      if (mine) b.addEventListener("click", () => this.meetup.sendTrick({ do: trick.id }));
      else if (next) b.addEventListener("click", () => this.teach());
      list.append(b);
    }
    const course = el("button", "trick next", "");
    course.type = "button";
    const best = this.journal?.agility?.bestSeconds;
    course.append(el("b", "", "Agility course"), el("span", "small", best ? `Set one up · best ${best} s` : "Set one up here"));
    course.addEventListener("click", () => { this.close(); this.agility?.(); });
    list.append(course);
    box.append(list, el("p", "small", "A lesson is a game of timing: press Space as each paw print reaches the ring. One slip is forgiven."));
    this.panel.replaceChildren(box);
  }
}
