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

/** The colours rooms are drawn in on the little picture of a plan, by what they are. */
const ROOM_HEX = { L: "#e9d9b5", K: "#d9e6ea", B: "#d7e3f2", T: "#cfe6dd", H: "#efe6cf", D: "#f0dcc6", S: "#e3dcef", P: "#f3e2ea", U: "#dedede" };

/** A plan drawn small, a floor beside a floor, as seen from above with the front door at the bottom. */
function drawPlan(plan) {
  const canvas = document.createElement("canvas");
  const floors = plan.floors;
  const all = floors.flatMap((f) => f.rooms);
  const a0 = Math.min(...all.map((r) => r.a0)), a1 = Math.max(...all.map((r) => r.a1)), b0 = Math.min(...all.map((r) => r.b0)), b1 = Math.max(...all.map((r) => r.b1));
  const pad = 10, gap = 14;
  const k = Math.min(26, (340 - pad * 2 - gap * (floors.length - 1)) / ((a1 - a0) * floors.length));
  const w = (a1 - a0) * k, h = (b1 - b0) * k;
  canvas.width = Math.round(pad * 2 + w * floors.length + gap * (floors.length - 1));
  canvas.height = Math.round(pad * 2 + h + 16);
  const pen = canvas.getContext("2d");
  pen.fillStyle = "#fffaf0";
  pen.fillRect(0, 0, canvas.width, canvas.height);
  floors.forEach((f, n) => {
    const left = pad + n * (w + gap);
    const x = (a) => left + (a - a0) * k, y = (b) => pad + (b1 - b) * k; // into the house is up the page
    for (const r of f.rooms) {
      pen.fillStyle = ROOM_HEX[r.kind] ?? "#eee";
      pen.fillRect(x(r.a0), y(r.b1), (r.a1 - r.a0) * k, (r.b1 - r.b0) * k);
      pen.strokeStyle = "#2b2620";
      pen.lineWidth = 1.5;
      pen.strokeRect(x(r.a0), y(r.b1), (r.a1 - r.a0) * k, (r.b1 - r.b0) * k);
      pen.fillStyle = "#2b2620";
      pen.font = `${Math.max(8, Math.min(11, ((r.a1 - r.a0) * k) / 7))}px system-ui, sans-serif`;
      pen.textAlign = "center";
      pen.textBaseline = "middle";
      pen.fillText(r.name.length > 14 ? `${r.name.slice(0, 13)}…` : r.name, x((r.a0 + r.a1) / 2), y((r.b0 + r.b1) / 2), (r.a1 - r.a0) * k - 4);
    }
    const s = plan.stairs;
    if (s) {
      pen.fillStyle = "rgba(138, 90, 58, .55)";
      pen.fillRect(x(s.a0), y(s.b1), (s.a1 - s.a0) * k, (s.b1 - s.b0) * k);
      pen.strokeStyle = "#5a3a24";
      for (let i = 1; i < 7; i++) {
        pen.beginPath();
        if (s.along === "b") { const b = s.b0 + ((s.b1 - s.b0) * i) / 7; pen.moveTo(x(s.a0), y(b)); pen.lineTo(x(s.a1), y(b)); }
        else { const a = s.a0 + ((s.a1 - s.a0) * i) / 7; pen.moveTo(x(a), y(s.b0)); pen.lineTo(x(a), y(s.b1)); }
        pen.stroke();
      }
    }
    if (n === 0) {
      // The front door, in the front wall of the room behind it.
      pen.fillStyle = "#b5372e";
      pen.fillRect(x(-0.45), y(0) - 2, 0.9 * k, 5);
    }
    pen.fillStyle = "#6b5d45";
    pen.font = "10px system-ui, sans-serif";
    pen.textAlign = "center";
    pen.fillText(floors.length === 1 ? "front door at the bottom, in red" : n === 0 ? "ground floor (door in red)" : "upstairs", left + w / 2, pad + h + 9);
  });
  return canvas;
}

export class Decor {
  /** @param {{ panel: HTMLElement, meetup: import("./net.js").Meetup, moveOut: () => void, token: () => string }} parts */
  constructor({ panel, meetup, moveOut, token }) {
    this.panel = panel;
    this.meetup = meetup;
    this.moveOut = moveOut;
    this.token = token ?? (() => "");
    this.read = null; // a plan read off a picture, waiting to be built: { plan, notes, lines, left }
    this.reading = false;
    this.readError = "";
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

  /** Sends a picture of a floor plan to be read, and shows what came of it. */
  async upload(file) {
    if (!file || this.reading) return;
    this.reading = true;
    this.readError = "";
    this.read = null;
    this.draw();
    try {
      const token = this.token();
      const res = await fetch("/v1/plan", { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: file });
      const got = await res.json().catch(() => ({}));
      if (res.ok && got.plan) this.read = got;
      else this.readError = `${got.error ?? "That did not work. Try again in a moment."}${typeof got.left === "number" ? ` (${got.left === 0 ? "no tries" : got.left === 1 ? "1 try" : `${got.left} tries`} left today)` : ""}`;
    } catch {
      this.readError = "The picture could not be sent. Are you still connected?";
    }
    this.reading = false;
    if (this.open) this.draw();
  }

  /** The part of the panel about a floor plan of one's own. */
  planBox(house) {
    const box = el("div", "plan");
    if (house.planned) {
      box.append(el("p", "small", "This house is built from your own plan, at its real size. The front door leads to it; from the street the house looks as it always did."));
      for (const line of house.planned) box.append(el("p", "small", line));
      const back = el("button", "out", "Go back to the house's own rooms");
      back.type = "button";
      back.addEventListener("click", () => this.meetup.sendHouse({ plan: null }));
      box.append(back);
    } else {
      box.append(el("p", "small", "Upload a picture of the floor plan of a real house (a photo, a screenshot or a PDF, up to two floors) and the inside of your house is built from it, at its real size, with stairs you can walk up. The outside stays as the map has it."));
    }
    if (!this.meetup.me?.signedIn) {
      box.append(el("p", "small", "Uploading a plan is for people signed in with their own account."));
      return box;
    }
    if (this.reading) {
      box.append(el("p", "reading", "Reading your plan... this can take a minute."));
      return box;
    }
    if (this.readError) box.append(el("p", "oops", this.readError));
    if (this.read) {
      const r = this.read;
      box.append(el("p", "small", "This is what was read off your picture:"), drawPlan(r.plan));
      for (const line of r.lines ?? []) box.append(el("p", "small", line));
      for (const note of r.notes ?? []) box.append(el("p", "small note", note));
      const build = el("button", "build", "Build my house from this");
      build.type = "button";
      build.addEventListener("click", () => { this.meetup.sendHouse({ plan: r.plan }); this.read = null; this.draw(); });
      box.append(build);
    }
    const pick = el("label", "pick", this.read ? "Try another picture" : house.planned ? "Upload another plan" : "Choose a picture of a floor plan");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,application/pdf";
    input.hidden = true;
    input.addEventListener("change", () => void this.upload(input.files?.[0]));
    pick.append(input);
    box.append(pick, el("p", "small", `Three tries a day${this.read ? `: ${this.read.left} left today` : ""}. Your picture is sent to the AI service to be read and is not kept by the game.`));
    return box;
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

    box.append(el("h3", "", "A plan of your own"), this.planBox(house));

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
