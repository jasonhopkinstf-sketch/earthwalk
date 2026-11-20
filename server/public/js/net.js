// Connection to the meetup room: who is here, where they are, and chat (docs/PROTOCOL.md).

export class Meetup extends EventTarget {
  constructor() {
    super();
    this.peers = new Map(); // id -> { name, avatar, lat, lon, alt, yaw, hasPosition }
    this.people = []; // everyone with an account: { id, name, avatar, online, room, place, lat, lon, lastSeen, home }
    this.joined = false;
    this.me = null;
    this.wanted = false;
    this.denied = false;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * `code` is the shared access code. A signed-in browser needs neither a code nor a name:
   * its sign-in cookie goes along with the connection and the server knows who it is.
   * @param {{ name?: string, room: string, avatar?: string, code?: string }} hello
   */
  connect(hello) {
    this.close();
    this.hello = hello;
    this.wanted = true;
    this.denied = false;
    this.open();
  }

  open() {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(`${scheme}//${location.host}/v1/ws`);
    this.ws = ws;
    ws.addEventListener("open", () => {
      const { name, room, avatar, code } = this.hello;
      ws.send(JSON.stringify({ t: "hello", room, ...(name ? { name } : {}), ...(avatar ? { avatar } : {}), ...(code ? { token: code } : {}) }));
    });
    ws.addEventListener("message", (e) => {
      if (this.ws !== ws) return;
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      this.handle(msg);
    });
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      const wasJoined = this.joined;
      this.joined = false;
      this.peers.clear();
      if (wasJoined) this.emit("notice", "Lost connection to the meetup server. Reconnecting...");
      else if (!this.denied) this.emit("unreachable");
      if (this.wanted && !this.denied) this.retry = setTimeout(() => this.open(), 4000);
    });
  }

  close() {
    this.wanted = false;
    clearTimeout(this.retry);
    const ws = this.ws;
    this.ws = null;
    ws?.close();
    this.joined = false;
    this.peers.clear();
  }

  send(obj) {
    if (this.joined && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendPosition(lat, lon, alt, yaw) {
    this.send({ t: "pos", lat, lon, alt, yaw });
  }

  sendChat(text) {
    if (!this.joined) this.emit("notice", "Not connected to the meetup server, so nobody can hear you yet.");
    else this.send({ t: "chat", text });
  }

  /** Sets my home: to the given place, or (with no arguments) to where I am standing now. */
  sendHome(place) {
    if (!this.joined) return this.emit("notice", "Not connected to the meetup server.");
    this.send(place ? { t: "home", lat: place.lat, lon: place.lon, name: place.name } : { t: "home" });
  }

  requestPeople() {
    this.send({ t: "people" });
  }

  /** Exact name first, then anyone whose name starts with what was typed. */
  findPeer(name) {
    const wanted = name.toLowerCase();
    let partial = null;
    for (const peer of this.peers.values()) {
      if (peer.name.toLowerCase() === wanted) return peer;
      if (!partial && peer.name.toLowerCase().startsWith(wanted)) partial = peer;
    }
    return partial;
  }

  /** Someone from the people list (any room), by the same name rule. */
  findPerson(name) {
    const wanted = name.toLowerCase();
    return this.people.find((p) => p.name.toLowerCase() === wanted) ?? this.people.find((p) => p.name.toLowerCase().startsWith(wanted)) ?? null;
  }

  handle(msg) {
    switch (msg.t) {
      case "welcome": {
        this.joined = true;
        this.me = { id: msg.id, name: msg.name, room: msg.room, avatar: msg.avatar, signedIn: !!msg.signedIn, personId: msg.personId ?? null, home: msg.home ?? null };
        this.peers.clear();
        for (const p of msg.peers ?? []) {
          this.peers.set(p.id, { name: p.name, avatar: p.avatar ?? "fox", lat: p.lat, lon: p.lon, alt: p.alt ?? 0, yaw: p.yaw ?? 0, hasPosition: typeof p.lat === "number" });
        }
        this.emit("welcome", { me: this.me, history: msg.history ?? [] });
        break;
      }
      case "join":
        this.peers.set(msg.id, { name: msg.name, avatar: msg.avatar ?? "fox", lat: 0, lon: 0, alt: 0, yaw: 0, hasPosition: false });
        this.emit("notice", `${msg.name} joined. Type /join ${msg.name} to go to them.`);
        break;
      case "leave": {
        const gone = this.peers.get(msg.id);
        this.peers.delete(msg.id);
        if (gone) this.emit("notice", `${gone.name} left.`);
        break;
      }
      case "peers":
        for (const [id, lat, lon, alt, yaw] of msg.p ?? []) {
          const peer = this.peers.get(id);
          if (peer) Object.assign(peer, { lat, lon, alt, yaw, hasPosition: true });
        }
        break;
      case "people":
        this.people = Array.isArray(msg.p) ? msg.p : [];
        this.emit("people", this.people);
        break;
      case "home":
        if (this.me) this.me.home = { lat: msg.lat, lon: msg.lon, name: msg.name };
        this.emit("home", this.me?.home);
        break;
      case "chat":
        this.emit("chat", { name: msg.name, text: msg.text });
        break;
      case "error":
        if (msg.code === "denied" || msg.code === "full") {
          this.denied = true;
          this.emit("denied", msg.code === "full" ? "That room is full." : "That access code was not accepted.");
        } else {
          this.emit("notice", msg.text);
        }
        break;
    }
  }
}
