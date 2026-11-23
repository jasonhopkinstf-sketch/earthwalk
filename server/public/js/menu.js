// The menu of everything (Tab), and the small box that asks "Where to?" when a thing to do needs a
// place or a name. What there is to do is the table in actions.js; what each one does is main.js's
// business (`act`, and `answer` for what was typed into the box). The Windows game's is SEarthMenu
// (game/Source/EarthWalk/EarthMenu.cpp), and this is laid out the same way.

import { actionGroups, findAction } from "./actions.js";

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
   * @param {{ panel: HTMLElement, askBox: HTMLElement, act: (id: string) => void, answer: (id: string, text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.asking = null; // the action whose question is up
    this.buildMenu();
    this.buildAsk();
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
  }

  /** Esc: everything of the menu's that is up goes away. */
  escape() {
    this.close();
    this.askDone("");
  }
}

export { findAction };
