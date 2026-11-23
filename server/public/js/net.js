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
    /** What I am riding, once the server has said so: { thing, sp, seat }. Each peer has a `ride` of the same shape. */
    this.ride = null;
    /** Things left standing where a rider got off: identity -> { thing, sp, lat, lon, alt, yaw, until }. */
    this.left = new Map();
    this.orders = new Map(); // thing -> what it has been told to keep doing (orders.js)
    this.taxis = new Map(); // thing -> a taxi on its way to whoever called it (taxi.js)
    this.cars = new Map(); // member id -> their own car, where it stands (garage.js)
    this.homes = new Map(); // "x/y/id" -> a house somebody lives in: { x, y, id, lat, lon, yaw, name, rev } (houses.js)
    this.house = null; // my own house, with how it is furnished (`decor`)
    this.race = null; // the race set up in this room, if any (race.js)
    this.play = null; // the game of tag or of hide and seek in this room, if any (play.js)
    /** Server time minus this device's time, in milliseconds, and the round trip of the measurement behind it. */
    this.clockOffset = 0;
    this.clockTrip = Infinity;
    this.clockTimers = [];
  }

  /**
   * The shared clock, in seconds: the server's time, as near as we can tell. Everyone in the world
   * agrees on it to within a few hundredths of a second, which is what keeps the animals in step.
   */
  now() {
    return (Date.now() + this.clockOffset) / 1000;
  }

  /** Asks the server the time a few times now, and once a minute after. The quickest answer is the truest. */
  syncClock() {
    for (const t of this.clockTimers) clearTimeout(t);
    const ask = () => this.send({ t: "time", c: performance.now() });
    this.clockTimers = [500, 1500, 3000, 6000].map((ms) => setTimeout(ask, ms));
    this.clockTimers.push(setInterval(() => { this.clockTrip *= 1.2; ask(); }, 60000));
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
      // `tz` is how far this clock is ahead of UTC, in minutes: the day's tasks turn over at the player's own midnight.
      ws.send(JSON.stringify({ t: "hello", room, ...(name ? { name } : {}), ...(avatar ? { avatar } : {}), ...(code ? { token: code } : {}), tz: -new Date().getTimezoneOffset() }));
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
    for (const t of this.clockTimers) clearTimeout(t);
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

  /** Asks to hop on something (the answer comes as a "ride" event), and says I have hopped off. */
  sendRide(thing, sp) {
    this.send({ t: "ride", thing, sp });
  }

  sendDismount() {
    this.send({ t: "ride" });
  }

  /** Says hello to a thing (no text), or says something to it. Its answer comes as a "say" event. */
  sendTalk(thing, sp, text, at) {
    // `at` is where I see the thing, in case it is asked to do something from there.
    this.send({ t: "talk", thing, sp, ...(text ? { text } : {}), ...(at ? { lat: +at.lat.toFixed(7), lon: +at.lon.toFixed(7) } : {}) });
  }

  /** Sets my home: to the given place, or (with no arguments) to where I am standing now. */
  sendHome(place) {
    if (!this.joined) return this.emit("notice", "Not connected to the meetup server.");
    this.send(place ? { t: "home", lat: place.lat, lon: place.lon, name: place.name } : { t: "home" });
  }

  /** Calls a taxi to take me to a place. It arrives as a "taxi" event. */
  sendTaxi(place) {
    this.send({ t: "taxi", place });
  }

  /** Chooses the companion that follows me, from those I have won (nothing for none). */
  sendPet(sp) {
    this.send(sp ? { t: "pet", sp } : { t: "pet" });
  }

  /** Buys a hat with my coins and puts it on. */
  buyHat(id) {
    this.send({ t: "hat", buy: id });
  }

  /** Puts on a hat I own (nothing for none). */
  wearHat(id) {
    this.send(id ? { t: "hat", wear: id } : { t: "hat" });
  }

  /** Sets out on an expedition from the passport ("hunt" is the treasure hunt of where I stand), or gives one up. My journal comes back. */
  startExpedition(id) {
    this.send({ t: "expedition", start: id });
  }

  dropExpedition(id) {
    this.send({ t: "expedition", drop: id });
  }

  /** My own car: bring it to where I stand, send it away, or choose (and if need be buy) its paint or body. */
  /** A race: "make" one where I stand, "join" the one set up, say "go" (its maker), or "stop" (leave it; its maker ends it). */
  sendRace(what) {
    this.send({ t: "race", [what]: true });
  }

  /** Tag, and hide and seek: { make: "tag" | "hide" } sets one up where I stand; { join }, { go } (its maker) and { stop } as for a race. */
  sendPlay(what) {
    this.send({ t: "play", ...what });
  }

  /** The garden of my house: `adopt` a young animal (a kind), `feed` one (its place), `gather` from a grown one, or `release` one. */
  sendGarden(what) {
    this.send({ t: "garden", ...what });
  }

  /** My companion's tricks: `learn` one (a lesson is set), hand in my `presses` for the lesson, or have it `do` one it knows. */
  sendTrick(what) {
    this.send({ t: "trick", ...what });
  }

  /** Food: `eat` something from my lunch box, ask for the `menu` of a "shop" or "food" place, or `buy` something `at` one. */
  sendFood(what) {
    this.send({ t: "food", ...what });
  }

  /** A house of my own: `claim` the one I am in, `leave` mine, or `put` a piece in it. */
  sendHouse(what) {
    this.send({ t: "house", ...what });
  }

  callCar() {
    this.send({ t: "garage", call: true });
  }

  sendCarAway() {
    this.send({ t: "garage", away: true });
  }

  chooseCar(choice) {
    this.send({ t: "garage", ...choice });
  }

  /** Gives up a favour I was asked; my journal comes back without it. */
  dropFavour(id) {
    this.send({ t: "favour", drop: id });
  }

  /** Asks for my own journal; it comes as a "journal" event. */
  requestJournal() {
    this.send({ t: "journal" });
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
          this.peers.set(p.id, { name: p.name, avatar: p.avatar ?? "fox", lat: p.lat, lon: p.lon, alt: p.alt ?? 0, yaw: p.yaw ?? 0, hasPosition: typeof p.lat === "number", ride: p.ride ?? null, pet: p.pet ?? null, hat: p.hat ?? null });
        }
        this.left = new Map((msg.left ?? []).map((l) => [l.thing, l]));
        this.orders = new Map((msg.orders ?? []).map((o) => [o.thing, o]));
        this.taxis = new Map((msg.taxis ?? []).map((x) => [x.thing, x]));
        this.cars = new Map((msg.cars ?? []).map((c) => [c.id, c]));
        this.homes = new Map((msg.lived ?? []).map((h) => [`${h.x}/${h.y}/${h.id}`, h]));
        this.house = msg.house ?? null;
        this.emit("homes", null);
        this.emit("house", this.house);
        this.race = msg.race ?? null;
        this.emit("race", this.race);
        this.play = msg.play ?? null;
        this.emit("play", this.play);
        if (this.ride) {
          this.ride = null; // a new connection starts on foot
          this.emit("ride", null);
        }
        if (typeof msg.now === "number") {
          this.clockOffset = msg.now - Date.now();
          this.clockTrip = Infinity;
          this.syncClock();
        }
        this.emit("welcome", { me: this.me, history: msg.history ?? [] });
        break;
      }
      case "time": {
        const trip = performance.now() - msg.c;
        if (typeof msg.now === "number" && trip >= 0 && trip < this.clockTrip) {
          this.clockTrip = trip;
          this.clockOffset = msg.now + trip / 2 - Date.now();
        }
        break;
      }
      case "ride": {
        // Somebody hopped on something (with `thing`) or off it (without).
        const ride = typeof msg.thing === "number" ? { thing: msg.thing, sp: msg.sp, seat: msg.seat ?? 0 } : null;
        if (ride) this.left.delete(ride.thing);
        if (msg.id === this.me?.id) {
          this.ride = ride;
          this.emit("ride", ride);
        } else {
          const peer = this.peers.get(msg.id);
          if (peer) peer.ride = ride;
        }
        break;
      }
      case "play":
        // The game of tag or of hide and seek in this room, whole, each time anything about it changes.
        this.play = msg.play ?? null;
        this.emit("play", this.play);
        break;
      case "race":
        // The race in this room, whole, each time anything about it changes; null when it is over and cleared away.
        this.race = msg.race ?? null;
        this.emit("race", this.race);
        break;
      case "lived": {
        // A house somebody has moved into or furnished anew, or (`gone`) one that is empty again.
        const key = `${msg.x}/${msg.y}/${msg.id}`;
        if (msg.gone) this.homes.delete(key);
        else this.homes.set(key, msg);
        this.emit("lived", msg);
        break;
      }
      case "lesson":
        this.emit("lesson", msg); // a lesson set for my companion, or how it went
        break;
      case "trick":
        if (typeof msg.thing === "number") this.emit("trick", msg); // somebody's companion does a trick
        break;
      case "menu":
        this.emit("menu", msg); // what the shop or café I am beside sells
        break;
      case "pep":
        this.emit("pep", !!msg.on); // all five hearts full: quicker on my feet
        break;
      case "house":
        this.house = msg.house ?? null;
        this.emit("house", this.house);
        break;
      case "car":
        // Somebody's own car has been called, moved or repainted; or (with no `thing`) has gone.
        if (typeof msg.thing === "number") this.cars.set(msg.id, msg);
        else this.cars.delete(msg.id);
        this.emit("car", msg);
        break;
      case "left":
        if (typeof msg.thing === "number") this.left.set(msg.thing, msg);
        break;
      case "order":
        // A thing was told to do something: to keep doing (follow, come, stay), to stop (home), or just the once.
        if (typeof msg.thing !== "number") break;
        if (msg.act === "follow" || msg.act === "come" || msg.act === "stay") this.orders.set(msg.thing, msg);
        else if (msg.act === "home") this.orders.delete(msg.thing);
        this.emit("order", msg);
        break;
      case "taxi":
        if (typeof msg.thing !== "number") break;
        if (msg.gone) { msg.by = this.taxis.get(msg.thing)?.by; this.taxis.delete(msg.thing); } else if (Array.isArray(msg.path)) this.taxis.set(msg.thing, msg);
        this.emit("taxi", msg);
        break;
      case "pet": {
        // Somebody's companion has come along, or gone home.
        const pet = typeof msg.sp === "string" && typeof msg.thing === "number" ? { sp: msg.sp, thing: msg.thing } : null;
        if (msg.id === this.me?.id) this.me.pet = pet;
        else if (this.peers.has(msg.id)) this.peers.get(msg.id).pet = pet;
        this.emit("pet", { id: msg.id, pet });
        break;
      }
      case "hat": {
        // Somebody has put a hat on, or taken it off.
        const hat = typeof msg.hat === "string" ? msg.hat : null;
        if (msg.id === this.me?.id) this.me.hat = hat;
        else if (this.peers.has(msg.id)) this.peers.get(msg.id).hat = hat;
        this.emit("hat", { id: msg.id, hat });
        break;
      }
      case "journal":
        this.emit("journal", msg.journal ?? null);
        break;
      case "stamp":
        this.emit("stamp", msg); // I earned something
        break;
      case "say":
        if (typeof msg.thing === "number") this.emit("say", msg); // a thing spoke, to me or to someone nearby
        break;
      case "join":
        this.peers.set(msg.id, { name: msg.name, avatar: msg.avatar ?? "fox", lat: 0, lon: 0, alt: 0, yaw: 0, hasPosition: false, ride: null, pet: null, hat: null });
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
        if (msg.code === "taken") this.emit("ridefail");
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
