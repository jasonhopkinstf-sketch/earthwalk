// The guide (Q): ask in plain words where you are, what is near, or how to get somewhere. The
// question goes to the server (docs/PROTOCOL.md, "The guide"), which knows where I stand and what I
// am riding; its answer comes up in the conversation bubble at the foot of the screen (menu.js), with
// buttons that start the trip ("Call a taxi", "Take me there", "Go there now", "Show me") and a few
// more questions to click. The line in the bubble takes the next question.
//
// The Windows game is to do the same from the same messages.

export const GUIDE_NAME = "Your guide";
const LINE = "Ask your guide something else, and press Enter";
/** How long an answer is waited for before the guide says it has none. */
const PATIENCE_MS = 25_000;
const KNOWN = new Set(["take", "taxi", "jump", "show"]);

export class GuideChat {
  /**
   * @param {{ meetup: import("./net.js").Meetup, menu: import("./menu.js").Menu, player: import("./player.js").Player,
   *   showcase: import("./showcase.js").Showcase, endTalk: () => void, notice: (text: string) => void, problem: (text: string) => void }} parts
   *   `endTalk` ends a conversation with a thing, which uses the same bubble.
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.open = false;
    this.answer = null; // the answer that is up: { text, place, go, ask }
    this.waiting = 0; // a timer, while a question is out
    this.meetup.addEventListener("guide", (e) => this.heard(e.detail));
    // Asked too fast, or before I have arrived anywhere: the server says so, and the guide passes it on.
    this.meetup.addEventListener("refused", (e) => { if (this.open && this.waiting && typeof e.detail?.text === "string") this.show({ text: e.detail.text, go: [], ask: [] }); });
  }

  /** Asks a question, opening the bubble if it is not up. */
  ask(question) {
    const q = String(question ?? "").trim().slice(0, 200);
    if (!q) return;
    if (!this.meetup.joined) return this.problem("Not connected to the meetup server, so the guide cannot hear you yet.");
    if (!this.open) {
      this.endTalk();
      this.menu.showTalk(GUIDE_NAME, [], LINE);
      this.open = true;
    }
    this.answer = null;
    this.menu.setTalkMine(`You: ${q}`);
    this.menu.setTalkWords("...");
    this.menu.setTalkReplies([]);
    this.meetup.sendGuide(q);
    clearTimeout(this.waiting);
    this.waiting = setTimeout(() => this.show({ text: "I could not get an answer just now. Ask me again in a moment.", go: [], ask: [] }), PATIENCE_MS);
  }

  heard(msg) {
    if (this.open && typeof msg.text === "string") this.show(msg);
  }

  /** Puts an answer up: its words, the ways to go there first, then the questions to click. */
  show(answer) {
    clearTimeout(this.waiting);
    this.waiting = 0;
    this.answer = answer;
    this.menu.setTalkWords(answer.text);
    const go = (answer.go ?? []).map((g, i) => (KNOWN.has(g.act) && (g.act === "show" || answer.place) ? [g.label, `go:${i}`, "go"] : null)).filter(Boolean);
    this.menu.setTalkReplies([...go, ...(answer.ask ?? []).slice(0, 6).map((q) => [q, q])]);
  }

  /** Something typed on the bubble's line, or one of its buttons clicked. */
  say(words) {
    const button = /^go:(\d+)$/.exec(words);
    if (button) this.go(this.answer?.go?.[Number(button[1])]);
    else this.ask(words);
  }

  /** One of the buttons under an answer: start the trip. The bubble goes, so that the trip can be seen. */
  go(button) {
    const place = this.answer?.place;
    if (!button) return;
    this.close();
    if (button.act === "show") return void this.showcase.go(button.show);
    if (!place) return;
    if (button.act === "take") {
      // What I am riding is told where; it says so itself, and carries me (orders.js).
      this.meetup.sendGuideTake(place);
    } else if (button.act === "taxi") {
      this.notice(`Calling a taxi to take you to ${place.name}...`);
      this.meetup.sendTaxi(place.name, place);
    } else if (button.act === "jump") {
      this.notice(`Travelling to ${place.name}`);
      this.player.travelTo(place.lat, place.lon);
    }
  }

  close() {
    if (!this.open) return;
    clearTimeout(this.waiting);
    this.waiting = 0;
    this.open = false;
    this.answer = null;
    this.menu.closeTalk();
  }
}
