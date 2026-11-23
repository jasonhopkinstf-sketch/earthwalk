// The menu of everything (Tab), the strip of buttons along the bottom, the small box that asks
// "Where to?" when a thing to do needs a place or a name, the speech bubble at the foot of the
// screen in which a thing is talked to, and the "What's new" card. What there is to do is the table in actions.js; what each one
// does is main.js's business (`act`, `answer` for what was typed into the box, `talkSay` and
// `talkEnd` for the conversation). The Windows game's is SEarthMenu
// (game/Source/EarthWalk/EarthMenu.cpp), and this is laid out the same way.

import { ACTIONS, actionGroups, findAction } from "./actions.js";

const el = (tag, cls, text) => {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** The key that does it, on a yellow cap like a key of the keyboard. */
const cap = (key) => el("kbd", "", key);

/** A click on a button must not take the keyboard from the game. */
function keepFocus(node) {
  node.addEventListener("mousedown", (e) => { if (e.target.closest("button")) e.preventDefault(); });
}

export class Menu {
  /**
   * @param {{ panel: HTMLElement, askBox: HTMLElement, strip: HTMLElement, talkBox: HTMLElement, newsBox: HTMLElement, act: (id: string) => void,
   *   answer: (id: string, text: string) => void, talkSay: (words: string) => void, talkEnd: () => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.asking = null; // the action whose question is up
    this.buildMenu();
    this.buildAsk();
    this.buildStrip();
    this.buildTalk();
    keepFocus(this.newsBox);
    this.newsBox.addEventListener("click", (e) => { if (e.target.closest("button")) this.closeNews(); });
  }

  // ---------------------------------------------------------------- what is new
  get newsOpen() {
    return !this.newsBox.hidden;
  }

  /**
   * The card: each release with its title and the things in it (newsnotes.js, `newsCard`). The heading and
   * the button stay put; what is between them scrolls when there is a lot of it.
   */
  showNews(entries) {
    this.close();
    document.exitPointerLock?.();
    const head = el("div", "head");
    head.append(el("h2", "", "What's new"), el("span", "dim", "Esc to close"));
    const body = el("div", "body");
    for (const entry of entries) {
      const title = el("div", "entry");
      title.append(el("h3", "", entry.title), el("span", "dim", entry.version));
      body.append(title);
      if (entry.note) body.append(el("p", "note", entry.note));
      const list = el("ul");
      for (const item of entry.items) {
        const line = el("li", "", item.text);
        if (item.note) line.append(el("span", "note", item.note));
        list.append(line);
      }
      body.append(list);
    }
    const foot = el("div", "foot");
    const button = el("button", "", "Got it");
    button.type = "button";
    foot.append(button);
    this.newsBox.replaceChildren(head, body, foot);
    this.newsBox.hidden = false;
  }

  closeNews() {
    this.newsBox.hidden = true;
  }

  // ---------------------------------------------------------------- the conversation with a thing
  buildTalk() {
    const head = el("div", "head");
    this.talkName = el("span", "name");
    head.append(this.talkName, el("span", "dim", "Esc to finish"));
    this.talkWords = el("div", "words");
    this.talkMine = el("div", "mine");
    this.talkReplies = el("div", "replies");
    this.talkInput = el("input");
    this.talkInput.maxLength = 300;
    this.talkInput.autocomplete = "off";
    this.talkBox.replaceChildren(head, this.talkWords, this.talkMine, this.talkReplies, this.talkInput);
    keepFocus(this.talkBox); // the typing line keeps the keyboard when a reply is clicked
    this.talkReplies.addEventListener("click", (e) => {
      const words = e.target.closest("button")?.dataset.words;
      if (words) this.talkSay(words);
    });
    // Enter says it and leaves the line ready for the next thing.
    this.talkInput.addEventListener("keydown", (e) => {
      if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
      e.preventDefault();
      const typed = this.talkInput.value.trim();
      this.talkInput.value = "";
      if (typed) this.talkSay(typed);
    });
  }

  get talking() {
    return !this.talkBox.hidden;
  }

  /** Opens the bubble on a thing: its name, and a few things to say with one click (each [label, words]). */
  showTalk(name, replies) {
    this.close();
    document.exitPointerLock?.();
    this.setTalkName(name);
    this.talkWords.textContent = "...";
    this.setTalkMine("");
    this.talkInput.value = "";
    this.talkReplies.replaceChildren(...replies.map(([label, words]) => {
      const button = el("button", "", label);
      button.type = "button";
      button.dataset.words = words;
      return button;
    }));
    this.talkBox.hidden = false;
    document.body.classList.add("talking");
    this.talkInput.focus();
  }

  closeTalk() {
    if (!this.talking) return;
    this.talkBox.hidden = true;
    document.body.classList.remove("talking");
    this.talkInput.blur();
  }

  focusTalk() {
    if (this.talking && !this.asking) this.talkInput.focus();
  }

  setTalkName(name) {
    this.talkName.textContent = name;
    this.talkInput.placeholder = `Say something to ${name}, and press Enter`;
  }

  /** What the thing has just said. */
  setTalkWords(text) {
    this.talkWords.textContent = text;
  }

  /** What I said to it last, small, under its words. */
  setTalkMine(text) {
    this.talkMine.hidden = !text;
    this.talkMine.textContent = text;
  }

  // ---------------------------------------------------------------- the strip of buttons
  /** The menu itself first, then the few things done most. */
  buildStrip() {
    const button = (id, key, label) => {
      const node = el("button");
      node.type = "button";
      node.dataset.act = id;
      if (key) node.append(cap(key));
      node.append(label);
      return node;
    };
    this.strip.replaceChildren(button("", "Tab", "Everything"), ...ACTIONS.filter((a) => a.strip).map((a) => button(a.id, a.key, a.strip)));
    keepFocus(this.strip);
    this.strip.addEventListener("click", (e) => {
      const node = e.target.closest("button");
      if (!node) return;
      if (node.dataset.act) this.act(node.dataset.act);
      else this.toggle();
    });
  }

  showStrip(on) {
    this.strip.hidden = !on;
  }

  // ---------------------------------------------------------------- the menu
  buildMenu() {
    const page = el("div", "page");
    const head = el("div", "head");
    head.append(el("h2", "", "What would you like to do?"), el("span", "dim", "Tab or Esc to close"));
    const groups = el("div", "groups");
    for (const group of actionGroups()) {
      const column = el("div", "group");
      column.append(el("h3", "", group.name));
      for (const action of group.actions) {
        const button = el("button", "act");
        button.type = "button";
        button.dataset.act = action.id;
        const words = el("span", "words");
        words.append(el("b", "", action.title), el("span", "about", action.about));
        button.append(words);
        if (action.key) button.append(cap(action.key));
        column.append(button);
      }
      groups.append(column);
    }
    page.append(head, el("p", "dim lead", "Click one. The yellow key beside it does the same thing without this list."), groups);
    this.panel.replaceChildren(page);
    keepFocus(this.panel);
    this.panel.addEventListener("click", (e) => {
      const button = e.target.closest("[data-act]");
      if (button) this.act(button.dataset.act);
      else if (e.target === this.panel) this.close(); // a click beside the list puts it away
    });
  }

  get open() {
    return !this.panel.hidden;
  }

  show() {
    document.exitPointerLock?.(); // the mouse is needed for choosing
    this.panel.hidden = false;
    this.panel.firstChild.scrollTop = 0;
  }

  close() {
    this.panel.hidden = true;
  }

  toggle() {
    if (this.open) this.close(); else this.show();
  }

  // ---------------------------------------------------------------- the box that asks
  buildAsk() {
    this.askTitle = el("div", "title");
    this.askInput = el("input");
    this.askInput.maxLength = 120;
    this.askInput.autocomplete = "off";
    this.askBox.replaceChildren(this.askTitle, this.askInput, el("div", "dim", "Enter to go. Esc to change your mind."));
    this.askInput.addEventListener("keydown", (e) => {
      if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
      e.preventDefault();
      e.stopPropagation(); // the Enter that answers is not also "open the chat"
      this.askDone(this.askInput.value.trim());
    });
    // The box keeps the keyboard until it is answered or Esc sends it away, wherever the pointer clicks.
    this.askInput.addEventListener("blur", () => setTimeout(() => { if (this.asking && document.hasFocus()) this.askInput.focus(); }, 0));
  }

  /** Puts the question of an action up: "Where to?" */
  ask(action) {
    this.close();
    document.exitPointerLock?.();
    this.asking = action;
    this.askTitle.textContent = action.ask;
    this.askInput.value = "";
    this.askInput.placeholder = `for example: ${action.askHint}`;
    this.askBox.hidden = false;
    this.askInput.focus();
  }

  /** The answer (or, with nothing, a change of mind). */
  askDone(text) {
    const action = this.asking;
    if (!action) return;
    this.asking = null;
    this.askBox.hidden = true;
    this.askInput.blur();
    if (text) this.answer(action.id, text);
    this.focusTalk(); // asked from inside a conversation ("Take me to..."): back to it
  }

  /**
   * Esc: the box that asks goes first, by itself (a change of mind is not the end of the conversation);
   * otherwise the menu and the conversation both go. True if only the box went.
   */
  escape() {
    if (this.asking) {
      this.askDone("");
      return true;
    }
    this.close();
    this.closeNews();
    if (this.talking) this.talkEnd();
    return false;
  }
}

export { findAction };
