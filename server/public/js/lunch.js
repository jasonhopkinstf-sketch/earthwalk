// Food and hearts. Five hearts in the corner, one for each kind of good food, filled by eating; the lunch
// box (the B key) with what is carried and a button to eat each thing; and, beside a real shop or café on
// the map, what it sells. The server keeps all of it (docs/PROTOCOL.md, "Food and hearts"): the journal
// says what is in the lunch box and which hearts are full, `menu` what is sold here, and `pep` whether all
// five hearts are full, which makes the player a little quicker on their feet for the rest of the day.

const ICON = { fruit: "🍎", veg: "🥕", grain: "🍞", protein: "🥚", dairy: "🥛" };
/** How near a shop's name board you must stand to buy there. */
const SHOP_M = 14;
/** How much quicker on foot with all five hearts full (the server's PEP). */
const PEP = 1.12;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

export class Lunch {
  /**
   * @param {{ panel: HTMLElement, hud: HTMLElement, meetup: import("./net.js").Meetup, world: import("./world.js").World,
   *   player: import("./player.js").Player, hint: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.journal = null;
    this.shop = null; // the shop or café within reach: { text, use }
    this.menu = null; // what it sells: { use, country, items }
    this.sinceScan = 0;
    const { meetup } = this;
    meetup.addEventListener("journal", (e) => { this.journal = e.detail; this.drawHearts(); if (this.open) this.draw(); });
    meetup.addEventListener("menu", (e) => { this.menu = e.detail; if (this.open) this.draw(); });
    meetup.addEventListener("pep", (e) => { this.player.pep = e.detail ? PEP : 1; });
    // The hearts are shown from the start, and kept up with whatever is given or eaten.
    meetup.addEventListener("welcome", () => { this.player.pep = 1; setTimeout(() => meetup.requestJournal(), 1500); });
    meetup.addEventListener("stamp", (e) => { if (e.detail?.kind === "food") meetup.requestJournal(); });
    this.hud.addEventListener("click", () => this.toggle());
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.open) return this.close();
    this.panel.hidden = false;
    document.exitPointerLock?.();
    this.meetup.requestJournal();
    this.askMenu();
    this.draw();
  }

  close() {
    this.panel.hidden = true;
  }

  askMenu() {
    this.menu = null;
    if (this.shop) this.meetup.sendFood({ menu: this.shop.use });
  }

  /** Every frame: is there a shop or a café within reach? */
  frame(dt) {
    if ((this.sinceScan += dt) < 0.3) return;
    this.sinceScan = 0;
    const { world, player: p } = this;
    let best = null;
    let bestD = SHOP_M;
    if (!p.waitingForGround) {
      const here = world.chunkAt(p.position.x, p.position.z);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const chunk = world.chunks.get(`${here.cx + dx}/${here.cy + dy}`);
          for (const sign of chunk?.shops ?? []) {
            const x = (chunk.x + sign.u - world.originX) * world.tileM, z = (chunk.y + sign.v - world.originY) * world.tileM;
            const d = Math.hypot(x - p.position.x, z - p.position.z);
            if (d < bestD) { bestD = d; best = sign; }
          }
        }
      }
    }
    if (best?.text !== this.shop?.text || best?.use !== this.shop?.use) {
      this.shop = best ? { text: best.text, use: best.use } : null;
      if (this.open) { this.askMenu(); this.draw(); }
    }
    this.hint(this.shop ? `B: buy food at ${this.shop.text}` : "");
  }

  /** The five hearts in the corner. */
  drawHearts() {
    const food = this.journal?.food;
    if (!food) return;
    this.hud.hidden = false;
    this.hud.className = food.full ? "full" : "";
    this.hud.title = food.full ? "All five hearts are full: you are quicker on your feet today (B opens your lunch box)" : "Your five hearts: eat each kind of good food to fill them (B opens your lunch box)";
    this.hud.replaceChildren(...food.hearts.map((h) => {
      const i = el("span", h.full ? "heart on" : "heart", ICON[h.group] ?? "♥");
      i.title = h.title;
      return i;
    }));
  }

  draw() {
    const j = this.journal;
    const box = el("div", "page");
    const close = el("button", "close", "×");
    close.type = "button";
    close.title = "Close (B)";
    close.addEventListener("click", () => this.close());
    box.append(close, el("h2", "", "Your lunch box"));
    if (!j?.food) {
      box.append(el("p", "small", "Opening it..."));
      return void this.panel.replaceChildren(box);
    }
    const food = j.food;
    const hearts = el("div", "hearts");
    for (const h of food.hearts) {
      const one = el("div", h.full ? "kind on" : "kind");
      one.append(el("span", "icon", ICON[h.group] ?? "♥"), el("span", "small", h.title));
      hearts.append(one);
    }
    box.append(hearts, el("p", "small", food.full
      ? "All five hearts are full. You are full of beans: quicker on your feet until tomorrow."
      : `Eat one of each kind of good food to fill all five hearts: you will be quicker on your feet, and get ${food.coinsFull} coins. Nothing is lost if you do not.`));
    const dots = (groups) => (groups.length ? groups.map((g) => ICON[g] ?? "").join("") : "a treat");

    const carried = food.larder.reduce((n, f) => n + f.n, 0);
    box.append(el("h3", "", `In the box (${carried} of ${carried + food.room})`));
    const list = el("div", "foods");
    for (const f of food.larder) {
      const b = el("button", "food");
      b.type = "button";
      b.append(el("b", "", `${cap(f.name)}${f.n > 1 ? ` ×${f.n}` : ""}`), el("span", "small", `Eat it · ${dots(f.groups)}`));
      b.addEventListener("click", () => this.meetup.sendFood({ eat: f.id }));
      list.append(b);
    }
    if (!food.larder.length) list.append(el("p", "small", "Empty. Talk (T) to a cow, a hen, a fruit tree, a tractor or a boat and it may give you something; or buy food at a real shop or café."));
    box.append(list);

    // Beside a shop or a café: what it sells.
    if (this.shop) {
      const coins = j.coins ?? 0;
      box.append(el("h3", "", `${this.shop.text} sells`), el("p", "coins", `${coins} coin${coins === 1 ? "" : "s"} to spend${this.menu?.country && this.shop.use === "food" ? ` · the food of ${/^(Netherlands|United |Philippines|Czech Republic)/.test(this.menu.country) ? "the " : ""}${this.menu.country}` : ""}`));
      const menu = el("div", "foods");
      for (const f of this.menu?.items ?? []) {
        const b = el("button", "food buy");
        b.type = "button";
        b.disabled = coins < f.price || food.room <= 0;
        b.append(el("b", "", cap(f.name)), el("span", "small", `${f.price} coins · ${dots(f.groups)}`));
        b.addEventListener("click", () => this.meetup.sendFood({ buy: f.id, at: this.shop.use }));
        menu.append(b);
      }
      if (!this.menu) menu.append(el("p", "small", "Asking what there is..."));
      box.append(menu);
    } else {
      box.append(el("p", "small", "Stand by a real shop or café with its name on a board, and B shows what it sells. Each country has its own food."));
    }
    const scroll = this.panel.firstElementChild?.scrollTop ?? 0;
    this.panel.replaceChildren(box);
    box.scrollTop = scroll;
  }
}
