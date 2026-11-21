// EarthWalk in the browser: join screen, the world, other players, chat and commands.

import * as THREE from "three";
import { ANIMALS, Avatars } from "./avatars.js";
import { Life } from "./life.js";
import { Meetup } from "./net.js";
import { Player } from "./player.js";
import { Riding } from "./riding.js";
import { Sounds } from "./sounds.js";
import { Traffic } from "./traffic.js";
import { World } from "./world.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const saved = JSON.parse(localStorage.getItem("earthwalk") ?? "{}");
const save = (patch) => localStorage.setItem("earthwalk", JSON.stringify(Object.assign(saved, patch)));

// ---------------------------------------------------------------- scene
const canvas = $("view");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const SKY = 0x9ec7e8;
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 900, 2600);
scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6a55, 1.15));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(70, 1, 0.2, 6000);
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const world = new World(scene);
const player = new Player(camera, world, canvas);
const avatars = new Avatars(scene);
const meetup = new Meetup();
const sounds = new Sounds();
sounds.enabled = saved.sound !== false;
const traffic = new Traffic(world, sounds);
const life = new Life(scene, world, sounds, traffic);
const riding = new Riding({
  world, player, meetup, avatars, life, traffic,
  say: (text) => notice(text),
  hint: (text) => { $("ride").hidden = !text; $("ride").textContent = text; },
});
life.riding = riding;
traffic.riding = riding;
// Browsers only let a page make sound once it has been clicked or typed in.
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => sounds.unlock());
let started = false;
/** The signed-in account (from /v1/me), or null for a guest. */
let account = null;

// ---------------------------------------------------------------- chat log
const log = $("log");
function addLine(text, kind = "", name = "") {
  const line = document.createElement("div");
  if (kind) line.className = kind;
  if (name) {
    const who = document.createElement("b");
    who.textContent = `${name}: `;
    line.append(who);
  }
  line.append(text);
  log.append(line);
  while (log.children.length > 80) log.firstChild.remove();
  log.scrollTop = log.scrollHeight;
}
const notice = (text) => addLine(text, "notice");
const problem = (text) => addLine(text, "error");

// ---------------------------------------------------------------- join screen
const animals = $("animals");
for (const a of ANIMALS) {
  const label = document.createElement("label");
  const input = Object.assign(document.createElement("input"), { type: "radio", name: "animal", value: a.id });
  const emoji = Object.assign(document.createElement("span"), { className: "emoji", textContent: a.emoji });
  label.append(input, emoji, a.label);
  animals.append(label);
}
const pick = (id) => { (animals.querySelector(`input[value="${id}"]`) ?? animals.querySelector("input")).checked = true; };
const emojiOf = (id) => ANIMALS.find((a) => a.id === id)?.emoji ?? "";
pick(saved.avatar ?? ANIMALS[Math.floor(Math.random() * ANIMALS.length)].id);
$("name").value = saved.name ?? "";
$("room").value = params.get("room") ?? saved.room ?? "family";
$("code").value = params.get("code") ?? saved.code ?? "";
const joinError = $("join-error");
if (params.get("signin") === "not-invited") {
  joinError.textContent = "That Google account is not invited yet. Enter the access code below and sign in again, or ask whoever runs the server to invite you.";
}

function join() {
  const hello = {
    name: $("name").value.trim(),
    room: $("room").value.trim() || "family",
    avatar: animals.querySelector("input:checked").value,
    code: $("code").value.trim(),
  };
  if (!hello.name && !account) return;
  joinError.textContent = "";
  $("go").disabled = true;
  $("go").textContent = "Joining...";
  save(hello);
  world.code = hello.code;
  meetup.connect(hello);
}

// Who am I? A sign-in cookie from an earlier visit means the join screen is only a formality.
const whoAmI = fetch("/v1/me").then((r) => (r.ok ? r.json() : null)).catch(() => null);
Promise.all([fetch("/health").then((r) => r.json()), whoAmI]).then(([health, me]) => {
  if (health.version) document.getElementById("credit").insertAdjacentText("afterbegin", "EarthWalk v" + health.version + " · ");
  account = me;
  // Only ask for a code when this server needs one (or the invite link carried one), and never from a signed-in person.
  $("code-row").hidden = !!me || (!health.codeRequired && !$("code").value);
  $("google-row").hidden = !health.googleSignIn || !!me;
  if (!me) return;
  $("account").hidden = false;
  $("account-name").textContent = me.name;
  // The name and animal they chose just before signing in become the account's; otherwise the account's win.
  const pending = saved.pending ?? {};
  $("name").value = pending.name || me.name;
  pick(pending.avatar || me.avatar);
  if (saved.pending) save({ pending: null });
  if (!params.has("stay")) join(); // straight in
}).catch(() => { joinError.textContent = "The world server is not answering. Try again in a moment."; });

$("join").addEventListener("submit", (e) => { e.preventDefault(); join(); });
$("google").addEventListener("click", () => {
  // Remember the choices on this screen, then go to Google. We come back to this same address (room and all).
  save({ pending: { name: $("name").value.trim(), avatar: animals.querySelector("input:checked").value }, room: $("room").value.trim(), code: $("code").value.trim() });
  const q = new URLSearchParams({ next: location.pathname + location.search });
  if ($("code").value.trim()) q.set("code", $("code").value.trim());
  location.href = `/auth/google?${q}`;
});
$("signout").addEventListener("click", (e) => { e.preventDefault(); signOut(); });

async function signOut() {
  try { await fetch("/auth/logout", { method: "POST" }); } catch { /* the cookie is cleared anyway */ }
  save({ pending: null });
  location.href = "/?stay=1";
}

function joinFailed(message) {
  if (started) return problem(message);
  meetup.close();
  joinError.textContent = message;
  $("go").disabled = false;
  $("go").textContent = "Enter the world";
  if (/code/i.test(message)) $("code-row").hidden = false;
}

meetup.addEventListener("denied", (e) => joinFailed(e.detail));
meetup.addEventListener("unreachable", () => { if (!started) joinFailed("Could not reach the meetup server. Check your connection and try again."); });
meetup.addEventListener("notice", (e) => notice(e.detail));
meetup.addEventListener("chat", (e) => addLine(e.detail.text, "", e.detail.name));
meetup.addEventListener("welcome", (e) => {
  const { me, history } = e.detail;
  const others = [...meetup.peers.values()].map((p) => p.name);
  if (!started) start(me);
  notice(`You are ${me.name} in room "${me.room}". ${others.length ? `Here now: ${others.join(", ")}.` : "Nobody else is here yet."}`);
  for (const line of history) addLine(line.text, "", line.name);
});
meetup.addEventListener("people", (e) => showPeople(e.detail));
meetup.addEventListener("home", (e) => { if (e.detail) notice(`Home set to ${e.detail.name}. You will start there next time.`); });

// ---------------------------------------------------------------- the world
function start(me) {
  started = true;
  $("join").hidden = true;
  $("hud").hidden = false;
  $("people").hidden = !me.signedIn;
  history.replaceState(null, "", location.pathname); // keep the access code out of the address bar
  // Where to appear: the link's coordinates, else the account's home, else where this device left off, else Paris.
  const home = me.home;
  const lat = parseFloat(params.get("lat") ?? home?.lat ?? saved.lat ?? "48.8583");
  const lon = parseFloat(params.get("lon") ?? home?.lon ?? saved.lon ?? "2.2945");
  player.travelTo(Number.isFinite(lat) ? lat : 48.8583, Number.isFinite(lon) ? lon : 2.2945);
  if (home && !params.has("lat")) notice(`Starting at home: ${home.name}.`);
  notice(me.signedIn
    ? "Welcome back. /home sets your home to where you stand; /who shows where everyone is; /help lists the rest."
    : "Welcome to EarthWalk. Try /goto Sydney Opera House, or /help.");
  setInterval(tickSlow, 100);
  renderer.setAnimationLoop(frame);
}

/** Scene positions of all players, this one first: the animals watch them. */
const everyone = [player.position];
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  player.update(dt);
  avatars.update(dt, meetup.peers, world);
  riding.frame(dt, meetup.now());
  everyone.length = 1;
  for (const entry of avatars.shown.values()) everyone.push(entry.group.position);
  life.update(dt, meetup.now(), everyone, camera);
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- where am I?
// The header names the place the player is in. It asks the server whenever the player has moved to
// another square about a kilometre across, and shows the coordinates until the answer comes.
const where = { key: "", name: "", timer: 0 };
function showWhere(here, travelling = false) {
  const coords = `${here.lat.toFixed(4)}, ${here.lon.toFixed(4)}`;
  $("where").hidden = false;
  $("where-name").textContent = travelling ? "Travelling..." : where.name || coords;
  $("where-sub").textContent = travelling ? "" : [where.country, where.name ? coords : ""].filter(Boolean).join("  ·  ");
}
function lookUpWhere(here) {
  const key = `${here.lat.toFixed(2)},${here.lon.toFixed(2)}`;
  if (key === where.key) return;
  where.key = key;
  clearTimeout(where.timer);
  where.timer = setTimeout(async () => {
    try {
      const res = await fetch(`/v1/place?lat=${here.lat.toFixed(2)}&lon=${here.lon.toFixed(2)}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
      const place = res.ok ? await res.json() : {};
      if (where.key !== key) return; // moved on meanwhile
      const changed = (place.name ?? "") !== where.name;
      where.name = place.name ?? "";
      where.country = place.country ?? "";
      if (changed && where.name) {
        // A little flourish, so arriving somewhere is noticed.
        $("where").classList.remove("arrived");
        void $("where").offsetWidth;
        $("where").classList.add("arrived");
      }
    } catch { /* the coordinates stay up */ }
  }, 1200);
}

let slowTicks = 0;
function tickSlow() {
  slowTicks++;
  world.update(player.position);
  const here = world.sceneToGeo(player.position);
  if (!player.waitingForGround) meetup.sendPosition(here.lat, here.lon, here.alt, player.heading);
  if (slowTicks % 5 === 0) {
    life.sync(player.position);
    if (player.waitingForGround) {
      where.name = "";
      where.country = "";
      where.key = "";
    } else lookUpWhere(here);
    showWhere(here, player.waitingForGround);
    const parts = [];
    if (player.flying) parts.push("flying");
    if (player.waitingForGround) parts.push(world.lastError || "building the world here...");
    parts.push(meetup.joined ? `room "${meetup.me.room}": ${meetup.peers.size + 1} here` : "meetup server: not connected");
    $("status").textContent = parts.join("  |  ");
  }
  if (slowTicks % 50 === 0 && !player.waitingForGround) save({ lat: here.lat, lon: here.lon });
}

// ---------------------------------------------------------------- people panel
const ago = (ts) => {
  const m = Math.round((Date.now() - ts) / 60000);
  return m < 2 ? "just now" : m < 60 ? `${m} min ago` : m < 48 * 60 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`;
};
const whereIs = (p) => (p.online
  ? `in "${p.room}"${p.place ? `, ${p.place}` : ""}`
  : `offline, last seen ${ago(p.lastSeen)}${p.place ? ` near ${p.place}` : ""}`);

function showPeople(people) {
  const list = $("people-list");
  list.replaceChildren();
  for (const p of people) {
    const li = document.createElement("li");
    li.className = p.online ? "online" : "offline";
    const dot = Object.assign(document.createElement("span"), { className: "dot" });
    const who = Object.assign(document.createElement("b"), { textContent: `${emojiOf(p.avatar)} ${p.name}` });
    const where = Object.assign(document.createElement("span"), { className: "where", textContent: whereIs(p) });
    li.append(dot, who, where);
    if (p.online) {
      li.title = `Go to ${p.name}`;
      li.addEventListener("click", () => goToPerson(p));
    }
    list.append(li);
  }
  if (!people.length) list.append(Object.assign(document.createElement("li"), { textContent: "Nobody has signed in yet." }));
}

/** Travels to someone from the people list, switching room first if they are in another one. */
function goToPerson(p) {
  if (!p.online) return problem(`${p.name} is not online right now.`);
  if (meetup.me && p.room !== meetup.me.room) {
    notice(`Joining room "${p.room}" to be with ${p.name}...`);
    $("room").value = p.room;
    save({ room: p.room });
    meetup.connect({ ...meetup.hello, room: p.room });
  }
  if (typeof p.lat === "number") {
    notice(`Travelling to ${p.name}${p.place ? ` (${p.place})` : ""}...`);
    player.travelTo(p.lat + 0.00003, p.lon);
  } else {
    problem(`${p.name} has not arrived anywhere yet. Try again in a moment.`);
  }
}

// ---------------------------------------------------------------- chat box and commands
const say = $("say");
addEventListener("keydown", (e) => {
  if (!started) return;
  if (e.code === "Enter" && document.activeElement !== say) {
    e.preventDefault();
    say.focus();
  } else if (e.code === "Escape" && document.activeElement === say) {
    say.blur();
  } else if (e.code === "KeyE" && document.activeElement !== say && !e.repeat) {
    riding.key(); // hop on whatever is nearest, or hop off
  }
});
say.addEventListener("focus", () => { player.typing = true; player.keys.clear(); });
say.addEventListener("blur", () => { player.typing = false; });
say.addEventListener("keydown", (e) => {
  if (e.code !== "Enter") return;
  const text = say.value.trim();
  say.value = "";
  say.blur();
  if (!text) return;
  if (text.startsWith("/")) {
    const space = text.indexOf(" ");
    command(text.slice(1, space < 0 ? undefined : space).toLowerCase(), space < 0 ? "" : text.slice(space + 1).trim());
  } else {
    meetup.sendChat(text);
  }
});

async function findPlace(query) {
  const res = await fetch(`/v1/geocode?q=${encodeURIComponent(query)}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
  return res.ok ? res.json() : null;
}

async function command(name, arg) {
  if (name === "help") {
    notice("/goto <place or lat, lon>   travel anywhere, e.g. /goto Times Square");
    notice("/join <name>   go to someone        /who   who is online and where");
    notice("/home   make where you stand your home (or /home <place>); you start there next time");
    notice("/name <name>   /animal <fox, bear, rabbit, cat, owl or frog>   /room <room>");
    notice("/invite   get a link to send to someone        /where   show your coordinates");
    notice("/fly   toggle flying (also the F key; Space and C go up and down)        /login   /logout");
    notice("/sound on or /sound off   the animals' voices, car horns and tractors");
    notice("E   hop on a horse, a cow, a tractor, a boat, a car or a passing train; E again hops off");
  } else if (name === "goto" && arg) {
    notice(`Looking for "${arg}"...`);
    try {
      const place = await findPlace(arg);
      if (!place) return problem(`Could not find "${arg}". Try a fuller name, or coordinates like 48.8583, 2.2945.`);
      notice(`Travelling to ${place.name}`);
      player.travelTo(place.lat, place.lon);
    } catch {
      problem("Could not reach the world server to look that up.");
    }
  } else if (name === "join" && arg) {
    const peer = meetup.findPeer(arg);
    if (peer && !peer.hasPosition) problem(`${peer.name} has not arrived anywhere yet. Try again in a moment.`);
    else if (peer) {
      notice(`Travelling to ${peer.name}...`);
      player.travelTo(peer.lat + 0.00003, peer.lon); // arrive a few metres away, not on top of them
    } else {
      const person = meetup.findPerson(arg);
      if (person) goToPerson(person);
      else problem(`Nobody called "${arg}" is here. Type /who to see who is around.`);
    }
  } else if (name === "who") {
    const names = [...meetup.peers.values()].map((p) => p.name);
    notice(names.length ? `Here with you: ${names.join(", ")}` : "Nobody else is in this room right now.");
    if (meetup.me?.signedIn) {
      for (const p of meetup.people) notice(`${emojiOf(p.avatar)} ${p.name}: ${whereIs(p)}`);
      if (!meetup.people.length) notice("Nobody else has signed in yet.");
      meetup.requestPeople();
    }
  } else if (name === "home") {
    if (!meetup.me?.signedIn) return problem("Sign in with Google (on the join screen) to have a home.");
    if (!arg) {
      if (player.waitingForGround) return problem("Wait until you have landed, then try /home again.");
      meetup.sendHome();
    } else {
      notice(`Looking for "${arg}"...`);
      try {
        const place = await findPlace(arg);
        if (!place) return problem(`Could not find "${arg}".`);
        meetup.sendHome(place);
      } catch {
        problem("Could not reach the world server to look that up.");
      }
    }
  } else if ((name === "name" || name === "animal" || name === "room") && arg) {
    const key = name === "animal" ? "avatar" : name;
    if (key === "avatar" && !ANIMALS.some((a) => a.id === arg.toLowerCase())) return problem(`Pick one of: ${ANIMALS.map((a) => a.id).join(", ")}.`);
    const hello = { ...meetup.hello, [key]: key === "avatar" ? arg.toLowerCase() : arg };
    save({ [key]: hello[key] });
    notice("Saved. Reconnecting...");
    meetup.connect(hello);
  } else if (name === "where") {
    const here = world.sceneToGeo(player.position);
    notice(`You are at ${here.lat.toFixed(6)}, ${here.lon.toFixed(6)}, ${Math.round(here.alt)} m above sea level.`);
  } else if (name === "fly") {
    player.setFlying(!player.flying);
  } else if (name === "sound") {
    sounds.enabled = arg ? /^(on|yes|1)$/i.test(arg) : !sounds.enabled;
    save({ sound: sounds.enabled });
    notice(sounds.enabled ? "Sound is on." : "Sound is off.");
  } else if (name === "login") {
    if (account) return notice(`You are signed in as ${account.name}.`);
    location.href = `/auth/google?${new URLSearchParams({ next: "/", ...(world.code ? { code: world.code } : {}) })}`;
  } else if (name === "logout") {
    if (!account) return notice("You are not signed in.");
    notice("Signing out...");
    signOut();
  } else if (name === "invite") {
    const link = new URL(location.origin);
    link.searchParams.set("room", meetup.me?.room ?? saved.room ?? "family");
    if (world.code) link.searchParams.set("code", world.code);
    try {
      await navigator.clipboard.writeText(link.href);
      notice(`Invite link copied: ${link.href}`);
    } catch {
      notice(`Invite link: ${link.href}`);
    }
  } else {
    problem("Unknown command. Type /help to see what you can do.");
  }
}

addEventListener("pagehide", () => {
  if (started && !player.waitingForGround) {
    const here = world.sceneToGeo(player.position);
    save({ lat: here.lat, lon: here.lon });
  }
});

// For the automated tests and for poking around in the browser console.
window.earthwalk = { world, player, meetup, avatars, life, traffic, riding, sounds, command, isStarted: () => started };
