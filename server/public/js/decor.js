// Furnishing a house of your own: a panel at the side of the screen, opened with H inside your house.
// Every piece there is comes from the server in the journal (`house.pieces`: what it is, what it costs or
// how it is won, whether it is yours); what stands in the house now comes in `house` messages. Choosing
// a piece tells the server, which builds the rooms again, and the house changes round you.

const SLOTS = [
  { slot: "walls", title: "Walls", plain: "As the house came" },
  { slot: "floor", title: "Floors", plain: "As the house came" },
  { slot: "sofa", title: "Sofa", plain: "The sofa it came with" },
  { slot: "bed", title: "Beds", plain: "The beds it came with" },
  { slot: "rug", title: "Rugs", plain: "The rugs it came with" },
];
const hexOf = (n) => `#${n.toString(16).padStart(6, "0")}`;
const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};
/** A round swatch of a piece's colours, side by side. */
function swatch(hex) {
  const i = el("i");
  const step = 100 / hex.length;
  i.style.background = hex.length === 1 ? hexOf(hex[0]) : `linear-gradient(90deg, ${hex.map((h, k) => `${hexOf(h)} ${k * step}% ${(k + 1) * step}%`).join(", ")})`;
  return i;
}

export class Decor {
  /** @param {{ panel: HTMLElement, meetup: import("./net.js").Meetup, moveOut: () => void }} parts */
  constructor({ panel, meetup, moveOut }) {
    this.panel = panel;
    this.meetup = meetup;
    this.moveOut = moveOut;
    this.journal = null;
    this.leaving = 0;
    this.parting = -1;
    meetup.addEventListener("journal", (e) => { this.journal = e.detail; if (this.open) this.draw(); });
    meetup.addEventListener("house", () => { if (this.open) this.draw(); });
  }

  get open() {
    return !this.panel.hidden;
  }

  toggle() {
    if (this.open) return this.close();
    this.panel.hidden = false;
    document.exitPointerLock?.(); // the mouse is wanted for the buttons
    this.meetup.requestJournal();
    this.draw();
  }

  close() {
    this.panel.hidden = true;
  }

  draw() {
    const house = this.meetup.house;
    const j = this.journal;
    const box = el("div", "page");
    const close = el("button", "close", "×");
    close.type = "button";
    close.title = "Close (H)";
    close.addEventListener("click", () => this.close());
    box.append(close, el("h2", "", "Your house"));
    if (!house || !j?.house) {
      box.append(el("p", "small", house ? "Fetching the catalogue..." : "You have no house yet."));
      return void this.panel.replaceChildren(box);
    }
    const coins = j.coins ?? 0;
    box.append(el("p", "coins", `${coins} coin${coins === 1 ? "" : "s"} to spend`));
    const decor = house.decor ?? { prizes: [] };
    const put = (what) => this.meetup.sendHouse({ put: what });
    const card = (piece, on, note, disabled, act) => {
      const b = el("button", on ? "piece on" : piece?.owned ? "piece owned" : "piece");
      b.type = "button";
      b.disabled = disabled;
      b.append(piece ? swatch(piece.hex) : el("i", "plain"), el("b", "", piece ? piece.name : note.plain), el("span", "small", piece ? note : note.text));
      if (!disabled) b.addEventListener("click", act);
      return b;
    };

    // The garden: young animals before the front door, fed from the lunch box until they are grown.
    const animals = house.animals ?? [];
    const fodder = j.food?.fodder ?? null;
    const garden = el("div", "pieces");
    animals.forEach((a, i) => {
      const row = el("div", a.ready || a.hungry ? "animal todo" : "animal");
      const name = a.name[0].toUpperCase() + a.name.slice(1);
      row.append(el("b", "", name), el("span", "small", a.grown ? `Grown: gives ${a.gives} a day` : `${a.fed} of ${a.meals} meals`));
      const act = el("button", "do", a.ready ? `Collect ${a.gives}` : a.grown ? "Given today" : !a.hungry ? "Fed today" : fodder ? `Feed it ${fodder}` : "Nothing it eats in your lunch box");
      act.type = "button";
      act.disabled = a.grown ? !a.ready : !a.hungry || !fodder;
      act.addEventListener("click", () => this.meetup.sendGarden(a.ready ? { gather: i } : { feed: i }));
      const go = el("button", "go", this.parting === i && this.leaving > performance.now() ? "Sure?" : "×");
      go.type = "button";
      go.title = "Send it to live on a farm";
      go.addEventListener("click", () => {
        if (this.parting === i && this.leaving > performance.now()) { this.parting = -1; return this.meetup.sendGarden({ release: i }); }
        this.parting = i;
        this.leaving = performance.now() + 5000;
        this.draw();
      });
      row.append(act, go);
      garden.append(row);
    });
    box.append(el("h3", "", `Your garden (${animals.length} of ${house.gardenMax ?? 4})`), garden);
    if (!animals.length) box.append(el("p", "small", "A young animal lives before your front door. Feed it once a day from your lunch box (plain vegetables, bread or fruit) and it grows up; then it gives you something every day. It never minds waiting if you are away."));
    const young = el("div", "pieces");
    for (const b of house.breeds ?? []) {
      const full = animals.length >= (house.gardenMax ?? 4);
      const buy = card({ name: `A ${b.young}`, hex: [{ chicken: 0xf2cc74, sheep: 0xf4f6fa, pig: 0xf2b8c6, cow: 0x6f4a30 }[b.sp] ?? 0xcccccc], owned: false }, false, full ? "The garden is full" : `${b.price} coins`, full || coins < b.price, () => this.meetup.sendGarden({ adopt: b.sp }));
      young.append(buy);
    }
    box.append(young);

    for (const { slot, title, plain } of SLOTS) {
      const row = el("div", "pieces");
      const chosen = decor[slot] ?? null;
      row.append(card(null, !chosen, { plain, text: chosen ? "Put it back" : "In place" }, false, () => put({ slot })));
      for (const p of j.house.pieces.filter((x) => x.slot === slot)) {
        const on = chosen === p.id;
        row.append(card(p, on, on ? "In place" : p.owned ? "Yours" : `${p.price} coins`, !p.owned && coins < p.price, () => put({ slot, id: p.id })));
      }
      box.append(el("h3", "", title), row);
    }

    // Prizes: won out in the world or bought, and stood in the house for visitors to see.
    const shown = decor.prizes ?? [];
    const prizes = el("div", "pieces");
    const all = j.house.pieces.filter((x) => x.slot === "prize");
    const rank = (p) => (shown.includes(p.id) ? 0 : p.owned ? 1 : p.price !== null ? 2 : 3);
    for (const p of [...all].sort((a, b) => rank(a) - rank(b))) {
      const on = shown.includes(p.id);
      const note = on ? "On show: put it away" : p.owned ? "Yours: put it on show" : p.price !== null ? `${p.price} coins` : p.how;
      const one = card(p, on, note, !on && !p.owned && (p.price === null || coins < p.price), () => put({ slot: "prize", id: p.id, on: !on }));
      if (!on) { prizes.append(one); continue; }
      // What is on show can be put down wherever I stand, turned, or sent back to a wall.
      const cell = el("div", "shown");
      const acts = el("div", "acts");
      const placed = !!decor.placed?.[p.id];
      const act = (text, what, disabled, title) => {
        const b = el("button", "", text);
        b.type = "button";
        b.disabled = disabled;
        b.title = title;
        b.addEventListener("click", () => this.meetup.sendHouse({ place: { id: p.id, ...what } }));
        acts.append(b);
      };
      act("Here", {}, false, "Put it down a step in front of where you stand, facing you");
      act("Turn", { turn: true }, !placed, "Turn it a quarter round");
      act("Wall", { wall: true }, !placed, "Send it back to stand against a wall");
      cell.append(one, acts);
      prizes.append(cell);
    }
    box.append(el("h3", "", `Things on show (${shown.length} of 10)`), el("p", "small", "Stand in your house where you want one and press Here: it is put down a step in front of you, facing you, and the furniture makes way. Turn turns it; Wall sends it back to a wall."), prizes);

    const out = el("button", "out", this.leaving > performance.now() ? "Really move out? Click again" : "Move out of this house");
    out.type = "button";
    out.addEventListener("click", () => {
      if (this.leaving > performance.now()) { this.leaving = 0; return this.moveOut(); }
      this.leaving = performance.now() + 6000;
      this.draw();
    });
    box.append(el("p", "small", "Your furniture and prizes stay yours if you move. Friends can walk in and look round."), out);
    const scroll = this.panel.firstElementChild?.scrollTop ?? 0;
    this.panel.replaceChildren(box);
    box.scrollTop = scroll;
  }
}
