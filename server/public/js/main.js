// EarthWalk in the browser: join screen, the world, other players, chat and commands.

import * as THREE from "three";
import { ANIMALS, Avatars } from "./avatars.js";
import { Life } from "./life.js";
import { Meetup } from "./net.js";
import { Player } from "./player.js";
import { Riding } from "./riding.js";
import { Sounds } from "./sounds.js";
import { Passport } from "./passport.js";
import { Orders } from "./orders.js";
import { Houses } from "./houses.js";
import { Decor } from "./decor.js";
import { Lunch } from "./lunch.js";
import { Train } from "./train.js";
import { CareBubbles } from "./carebubbles.js";
import { Garden } from "./garden.js";
import { Taxis } from "./taxi.js";
import { Pets } from "./pets.js";
import { Garage } from "./garage.js";
import { Races } from "./race.js";
import { Play } from "./play.js";
import { Treasure } from "./treasure.js";
import { Showcase } from "./showcase.js";
import { Talk } from "./talk.js";
import { findAction, Menu } from "./menu.js";
import { GUIDE_QUESTIONS, quickReplies } from "./actions.js";
import { GuideChat } from "./guide.js";
import { MiniMap } from "./minimap.js";
import { newsCard } from "./newsnotes.js";
import { HAZE, Ink, LAYER, Sky, look, onLook, setLook } from "./look.js";
import { lookSaid, parseLook } from "./lookdata.js";
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
const scene = new THREE.Scene();
// Far land sinks into the haze the sky paints under its horizon (look.js).
renderer.setClearColor(HAZE);
scene.fog = new THREE.Fog(HAZE, 900, 2600);
scene.add(new THREE.HemisphereLight(0xffffff, 0x5a6a55, 1.15));
const sun = new THREE.DirectionalLight(0xfff2dd, 2.1);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);
const camera = new THREE.PerspectiveCamera(70, 1, 0.2, 6000);
camera.layers.enable(LAYER.over);
camera.layers.enable(LAYER.sky);
const sky = new Sky(scene, sun.position);
// The flat look's black line (look.js): a second pass over the picture, made only while it is wanted.
const ink = new Ink(renderer);
onLook(() => { if (look.name !== "flat" || !look.lines) ink.rest(); });
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener("resize", resize);
resize();

const world = new World(scene);
world.fresh = new URLSearchParams(location.search).has("fresh");
const player = new Player(camera, world, canvas);
const avatars = new Avatars(scene);
const meetup = new Meetup();
const sounds = new Sounds();
sounds.enabled = saved.sound !== false;
const traffic = new Traffic(world, sounds);
const life = new Life(scene, world, sounds, traffic);
// What the E and T keys would do just now, shown together at the bottom of the screen.
const hints = { ride: "", talk: "", door: "", food: "", care: "" };
function showHints() {
  const text = [hints.ride || hints.door, hints.care || hints.talk, hints.food].filter(Boolean).join("   ·   ");
  $("ride").hidden = !text;
  $("ride").textContent = text;
}
const riding = new Riding({
  world, player, meetup, avatars, life, traffic,
  say: (text) => notice(text),
  hint: (text) => { if (hints.ride !== text) { hints.ride = text; showHints(); } },
});
const talk = new Talk({
  scene, world, player, meetup, life, traffic, riding,
  hint: (text) => { if (hints.talk !== text) { hints.talk = text; showHints(); } },
  // What a thing says goes into its own bubble at the foot of the screen, never into the chat window.
  said: (msg) => { if (menu.talking && talk.to?.thing === msg.thing) menu.setTalkWords(msg.text); },
  changed: () => { if (!talk.to) menu.closeTalk(); else if (menu.talking) menu.setTalkName(talkName()); },
});
life.riding = riding;
traffic.riding = riding;
const decor = new Decor({ panel: $("decor"), meetup, moveOut: () => houses.moveOut(), token: () => world.code });
const houses = new Houses({
  world, player, meetup, decor,
  say: (text) => notice(text),
  hint: (text) => { if (hints.door !== text) { hints.door = text; showHints(); } },
});
const lunch = new Lunch({
  panel: $("lunch"), hud: $("hearts"), meetup, world, player, atHome: () => houses.mine(),
  hint: (text) => { if (hints.food !== text) { hints.food = text; showHints(); } },
});
const orders = new Orders({ world, player, meetup, avatars, life, traffic, riding, say: (text) => notice(text) });
const taxis = new Taxis({ world, meetup, riding, say: (text) => notice(text) });
const pets = new Pets({ scene, world, player, meetup, avatars, riding });
const care = new CareBubbles({ scene, world, player, meetup, life, hint: (text) => { if (hints.care !== text) { hints.care = text; showHints(); } } });
const train = new Train({ panel: $("train"), bar: $("lesson"), meetup, player, agility: () => races.agility(), say: (text) => notice(text) });
const garage = new Garage({ world, meetup, riding, traffic });
const garden = new Garden({ world, player, meetup, riding });
const play = new Play({ scene, world, meetup, player, avatars, talk, panel: $("play"), banner: $("playcount"), blind: $("blind"), say: (text) => notice(text) });
const races = new Races({ scene, world, meetup, pets, panel: $("race"), banner: $("countdown"), say: (text) => notice(text) });
// "Show me...": straight to a train, a horse, a car to drive, for showing the world to somebody (G).
const showcase = new Showcase({ panel: $("show"), world, player, life, traffic, riding, meetup, say: (text) => notice(text), problem: (text) => problem(text) });
// Browsers only let a page make sound once it has been clicked or typed in.
for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => sounds.unlock());
// The menu of everything (Tab), and the box that asks "Where to?" (menu.js).
const menu = new Menu({
  panel: $("menu"), askBox: $("ask"), strip: $("strip"), talkBox: $("talkbox"), newsBox: $("news"),
  act: (id) => menuAction(id), answer: (id, text) => askDone(id, text), talkSay: (words) => talkSay(words), talkEnd: () => { talk.stop(); guide.close(); },
});
// The guide (Q): asked in plain words where I am or how to get somewhere, it answers in the same bubble (guide.js).
const guide = new GuideChat({ meetup, menu, player, showcase, endTalk: () => talk.stop(), notice: (text) => notice(text), problem: (text) => problem(text) });
/** "Daisy the cow"; "The cow" until she has said who she is. */
const talkName = () => talk.title(talk.to).replace(/^./, (c) => c.toUpperCase());
/** The conversation with a thing opens: its bubble at the foot of the screen, with a line to type on. */
function openTalk() {
  if (!talk.to || menu.talking) return;
  passport.close();
  showcase.close();
  menu.showTalk(talkName(), quickReplies(talk.to.sp, riding.mine?.thing === talk.to.thing));
}
/** Something said to the thing: typed on its line, or one of the things to say with one click. */
function talkSay(words) {
  if (guide.open) return guide.say(words); // the bubble is the guide's: a question, or one of its buttons
  if (!talk.to || !words) return;
  if (words === "...") return menuAction("taketo"); // "Take me to...": where to, first
  talk.say(words);
  menu.setTalkMine(`You: ${words}`);
  menu.setTalkWords("...");
}
// The little map in the corner (M): small unless it was made large or hidden, and that is remembered.
const minimap = new MiniMap({ canvas: $("minimap"), renderer, scene, camera, world, player, meetup, riding, traffic, houses, orders, saved: saved.map, save: (name) => save({ map: name }) });
const cycleMap = () => notice(minimap.cycle());
// The strip of buttons along the bottom: there unless it was hidden (Z), and that is remembered.
let stripOn = saved.strip !== "off";
menu.showStrip(stripOn);
function toggleStrip() {
  stripOn = !stripOn;
  menu.showStrip(stripOn);
  save({ strip: stripOn ? "on" : "off" });
  notice(stripOn ? "The buttons are back. Z hides them." : "The buttons are hidden. Z brings them back, and Tab still shows everything you can do.");
}
/**
 * "What's new": the release notes since the ones this player last saw, on a card. On arriving (`onlyNew`)
 * it is quiet when there is nothing to tell or the player is busy; from the menu it shows the newest three.
 */
async function openNews(onlyNew) {
  const seen = saved.newsSeen;
  let answer;
  try {
    const res = await fetch(`/v1/news${onlyNew && seen ? `?since=${encodeURIComponent(seen)}` : ""}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
    answer = res.ok ? await res.json() : null;
  } catch { answer = null; }
  if (!Array.isArray(answer?.news)) {
    if (!onlyNew) problem("Could not fetch what is new just now."); // on arriving that is nothing to mention
    return;
  }
  const entries = newsCard(answer.news, "browser", onlyNew && !seen);
  if (typeof answer.latest === "string" && answer.latest) save({ newsSeen: answer.latest });
  if (!entries.length) {
    if (!onlyNew) notice("Nothing new to tell of just now.");
    return;
  }
  // Busy with something else by now: it is in the menu when wanted.
  if (onlyNew && (typingNow() || menu.open || menu.asking || menu.talking || passport.open || showcase.open)) return;
  passport.close();
  showcase.close();
  menu.showNews(entries);
}
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
const passport = new Passport({ panel: $("passport"), toast: $("stamp"), meetup, animal: (id) => void command("animal", id), goHome: () => houses.goHome() });
const treasure = new Treasure({ scene, world });
// "/clue" asks for my journal and reads out the clue I am on.
let wantClue = false;
meetup.addEventListener("journal", (e) => {
  if (!wantClue) return;
  wantClue = false;
  const h = e.detail?.hunt;
  notice(h ? `Clue ${h.at + 1} of ${h.of}: ${h.clue}${h.way ? ` It is ${h.way}.` : ""}` : "You are not on a treasure hunt. Start one from your passport (P).");
});
// A treasure found: the chest stands a few steps ahead of me, where I am looking.
meetup.addEventListener("stamp", (e) => { if (e.detail.at) treasure.show(e.detail.at.lat, e.detail.at.lon, Math.sin(player.yaw) * 3.5, -Math.cos(player.yaw) * 3.5); });
meetup.addEventListener("stamp", (e) => notice(`${e.detail.kind === "country" ? "New country" : e.detail.kind === "level" ? "Level up" : e.detail.kind === "riddle" ? "Riddles" : e.detail.kind === "task" ? "Today" : e.detail.kind === "prize" ? "A prize" : e.detail.kind === "favour" ? "A favour" : e.detail.kind === "hunt" ? "Treasure hunt" : e.detail.kind === "expedition" ? "Expedition" : e.detail.kind === "race" ? "Race" : e.detail.kind === "play" ? "Game over" : e.detail.kind === "food" ? "Food" : e.detail.kind === "trick" ? "A new trick" : e.detail.kind === "care" ? "Animals" : "New stamp"}: ${e.detail.title}. ${e.detail.text ?? ""}${e.detail.kind === "riddle" || e.detail.kind === "prize" || e.detail.kind === "hunt" || e.detail.kind === "food" || e.detail.kind === "trick" || e.detail.kind === "care" ? "" : " (P opens your passport)"}`));
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
    ? "Welcome back. Tab shows everything you can do."
    : "Welcome to EarthWalk. Click the view to look around, walk with W, A, S and D, and press Tab to see everything you can do.");
  setInterval(tickSlow, 100);
  renderer.setAnimationLoop(frame);
  // What is new since last time, a few seconds after arriving: once the world is on the screen.
  if (!params.has("nonews")) setTimeout(() => void openNews(true), 8000);
}

const speedo = $("speedo");
/** Scene positions of all players, this one first: the animals watch them. */
const everyone = [player.position];
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  orders.steer(dt);
  player.update(dt);
  // At the wheel: the speed in the corner, the engine's note, and my own figure on the car, now that I can see it.
  const car = player.mount ? player.car : null;
  speedo.hidden = !car;
  if (car) speedo.textContent = `${Math.round(Math.abs(car.speed) * 3.6)} km/h`;
  sounds.engine(car ? Math.min(1, Math.abs(car.speed) / player.mount.drive.top) : null, !!car && !player.typing && player.keys.has("KeyW"));
  avatars.showSelf(dt, car || player.view ? meetup.me : null, player.position, -player.yaw);
  avatars.update(dt, meetup.peers, world);
  riding.frame(dt, meetup.now());
  showcase.frame();
  talk.frame(dt);
  houses.frame(dt);
  lunch.frame(dt);
  train.frame();
  treasure.frame(dt);
  races.frame();
  play.frame(meetup.now());
  everyone.length = 1;
  for (const entry of avatars.shown.values()) everyone.push(entry.group.position);
  life.update(dt, meetup.now(), everyone, camera);
  care.frame(meetup.now());
  sky.frame(camera, meetup.now());
  if (look.name === "flat" && look.lines) ink.render(scene, camera);
  else renderer.render(scene, camera);
  minimap.frame();
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
/** Is the keyboard in a box for typing in? Then the game's own keys are letters. */
const typingNow = () => {
  const at = document.activeElement;
  return !!at && (at.tagName === "TEXTAREA" || (at.tagName === "INPUT" && !/^(radio|checkbox|button|submit)$/.test(at.type)));
};
function syncTyping() {
  const typing = typingNow();
  if (typing && !player.typing) player.keys.clear();
  player.typing = typing;
}
document.addEventListener("focusin", syncTyping);
document.addEventListener("focusout", () => setTimeout(syncTyping, 0));

// What the keys do, by name, so that the menu's buttons do the very same things.
/** E: a door within reach, and nothing to ride: go in or out. Otherwise hop on whatever is nearest, or hop off. */
function rideKey() {
  if (houses.near && !riding.mine && !riding.near) void houses.use();
  else riding.key();
}
/** T: in a round-up the animal beside me follows at once; otherwise it says hello in its bubble, with a line to answer on. True if there was something to talk to. */
function talkKey() {
  if (play.lead()) return true;
  if (menu.talking && !guide.open) { menu.focusTalk(); return true; } // back to the line, after a walk about
  if (!talk.begin()) {
    if (guide.open) menu.focusTalk(); // nothing here to talk to: back to the guide's line
    return guide.open;
  }
  guide.close(); // the bubble is the thing's now
  openTalk();
  return true;
}
/** Q: the guide. The box that asks what I would like to know, with questions ready to click; or, with its answer up, back to its line. */
function guideKey() {
  if (guide.open) menu.focusTalk();
  else menuAction("guide");
  return true; // the Q that opens the box is not also its first letter
}
/** R: join or start the game that is set up here; failing one, a race. */
function raceKey() {
  if (!play.key()) races.key();
}
/** V: riding or being carried: the seat, the view from above, the view from high up. */
function viewKey() {
  const view = player.nextView();
  notice(view === null ? "V looks down from above while you are riding something, or being carried: hop on first (E)."
    : view === "your seat" ? "Back in your seat."
    : `Looking ${view}. The mouse swings the camera round, the wheel brings it nearer or further, and V moves on.`);
}
/** K: my companion's tricks. */
function tricksKey() {
  decor.close();
  lunch.close();
  train.toggle();
}
/** B: my lunch box, my hearts, and what the shop beside me sells. */
function lunchKey() {
  train.close();
  decor.close();
  lunch.toggle();
}
/** H: make this house mine, furnish my own, or go home. */
function homeKey() {
  lunch.close();
  houses.home();
}
function toggleMenu() {
  if (!menu.open) { passport.close(); showcase.close(); }
  menu.toggle();
}

/** One thing from the menu, by its name there: what a click on it does, and "/do goto". */
function menuAction(id) {
  const action = findAction(id);
  if (!action) return problem(`There is nothing called "${id}" to do. Tab shows everything there is.`);
  menu.close();
  if (action.ask) {
    passport.close();
    showcase.close();
    return menu.ask(action, id === "guide" ? GUIDE_QUESTIONS : []);
  }
  if (id === "ride") rideKey();
  else if (id === "talk") { if (!talkKey()) notice("There is nothing near enough to talk to. Walk up to an animal, a car, a tree or a house."); }
  else if (id === "race") raceKey();
  else if (id === "shows") void showcase.toggle();
  else if (id === "passport") passport.toggle();
  else if (id === "chat") say.focus();
  else if (id === "strip") toggleStrip();
  else if (id === "map") cycleMap();
  else if (id === "news") void openNews(false);
  else if (id === "above") viewKey();
  else if (id === "sound") void command("sound", sounds.enabled ? "off" : "on");
  else if (id === "look") void command("look", look.name === "flat" ? "barnyard" : "flat");
  else if (id === "tricks") tricksKey();
  else if (id === "myhouse") homeKey();
  else if (id === "lunch") lunchKey();
  else if (!action.command) notice(`"${action.title}" is on its way to this game.`);
  else {
    // Everything else is a command by another name.
    const space = action.command.indexOf(" ");
    void command(space < 0 ? action.command : action.command.slice(0, space), space < 0 ? "" : action.command.slice(space + 1));
  }
}

/** What was typed into the box that asks: the place, the name. */
function askDone(id, text) {
  const action = findAction(id);
  if (id === "taketo") {
    // Said to whatever I am on (or in): "take me to the beach".
    if (riding.mine && talk.beginRide()) {
      openTalk();
      talkSay(`take me to ${text}`); // it answers in its bubble
    }
    else notice("Hop on something first (E beside an animal or a car), then ask it to take you. Or call a taxi: it comes to you.");
  } else if (action) void command(action.command, text);
}

addEventListener("keydown", (e) => {
  if (!started) return;
  const typing = typingNow();
  if (e.code === "Tab") {
    e.preventDefault(); // the keyboard stays with the game
    if (!typing && !e.repeat) toggleMenu();
  } else if ((e.code === "Enter" || e.code === "NumpadEnter") && !typing) {
    e.preventDefault();
    menu.close();
    say.focus();
  } else if (e.code === "Escape") {
    if (menu.escape()) return; // only the box that asked went: a change of mind
    if (document.activeElement === say) say.blur();
    passport.close();
    showcase.close();
    decor.close();
    lunch.close();
    train.close();
    guide.close();
    talk.stop(); // and stop talking to whatever it was
  } else if (typing || e.ctrlKey || e.metaKey || e.altKey) {
    // Letters, in a box for typing in; or the browser's own shortcuts.
  } else if (showcase.open && showcase.key(e.code)) {
    e.preventDefault(); // a number chose something from the list
  } else if (e.code === "Space" && train.lesson) {
    if (!e.repeat) train.press(); // on the beat, I hope
    e.preventDefault();
  } else if (train.open && /^Digit[1-9]$/.test(e.code) && !e.repeat) {
    train.perform(Number(e.code.slice(5)) - 1);
  } else if (!e.repeat && KEYS[e.code]) {
    if (e.code !== "KeyZ" && e.code !== "KeyM") menu.close(); // a key that does something of its own puts the menu away, and goes on to do it
    if (KEYS[e.code]() === true) e.preventDefault();
  }
});
/** The keys that each do one thing. (M and Z are kept for the little map and the strip of buttons.) */
const KEYS = {
  KeyT: talkKey, // talk to what is nearest
  KeyQ: guideKey, // ask the guide
  KeyG: () => void showcase.toggle(), // things to show somebody
  KeyP: () => passport.toggle(), // where I have been and what I have done
  KeyR: raceKey,
  KeyK: tricksKey,
  KeyB: lunchKey,
  KeyH: homeKey,
  KeyV: viewKey,
  KeyE: rideKey,
  KeyC: () => { if (!player.flying) menuAction("car"); }, // my car comes to me (flying, C is "down")
  KeyX: () => menuAction("taxi"), // a taxi: where to?
  KeyZ: toggleStrip,
  KeyM: cycleMap,
};
say.addEventListener("keydown", (e) => {
  if (e.code !== "Enter" && e.code !== "NumpadEnter") return;
  e.stopPropagation(); // the Enter that sends is not also "open the chat": the line is put away, and the keys are the game's again
  const text = say.value.trim();
  say.value = "";
  say.blur();
  if (!text) return;
  if (text.startsWith("/")) {
    const space = text.indexOf(" ");
    command(text.slice(1, space < 0 ? undefined : space).toLowerCase(), space < 0 ? "" : text.slice(space + 1).trim());
  } else {
    meetup.sendChat(text); // to the room, always: a thing is spoken to on the line of its own bubble
  }
});

/** A place by name, looked for from where I stand: "the beach" is the beach down the road, not a town of that name abroad. */
async function findPlace(query) {
  const here = player.waitingForGround ? null : world.sceneToGeo(player.position);
  const from = here ? `&lat=${here.lat.toFixed(5)}&lon=${here.lon.toFixed(5)}` : "";
  const res = await fetch(`/v1/geocode?q=${encodeURIComponent(query)}${from}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
  return res.ok ? res.json() : null;
}

/** What can be told where to take its rider (deedsOf in server/src/talk.ts): cars, and the animals that carry. */
const CARRIERS = new Set(["car", "tractor", "taxi", "horse", "cow", "sheep", "camel", "llama", "kangaroo", "deer", "donkey", "pig", "goat", "zebra", "elephant", "giraffe", "bison", "moose", "reindeer", "bear", "lion", "panda", "tortoise"]);

/** How far off, for people: "120 m", "2.3 km". */
const far = (m) => (m < 950 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1)} km`);

async function command(name, arg) {
  if (name === "menu") {
    toggleMenu();
  } else if (name === "buttons") {
    toggleStrip();
  } else if (name === "map") {
    cycleMap();
  } else if (name === "news") {
    void openNews(false);
  } else if (name === "look") {
    // The look of the whole world: "/look flat", "/look barnyard", and "/look flat nolines" for a slow computer.
    const asked = parseLook(arg);
    if (asked) {
      setLook(asked.name, asked.lines);
      save({ look: look.name, lines: look.lines ? "on" : "off" });
      notice(lookSaid(look.name, look.lines));
    } else notice(`This is the ${look.name} look. /look flat   bright flat colours and bold black lines        /look barnyard   the painted look`);
  } else if (name === "guide" || name === "ask") {
    // "/guide where is the nearest station": straight to the answer. With no question, the box that asks for one.
    if (arg) guide.ask(arg);
    else guideKey();
  } else if (name === "do") {
    menuAction(arg.toLowerCase()); // one thing from the menu by its name there
  } else if (name === "houses") {
    const where = houses.nearestDoor();
    notice(where ? `The nearest house you can go into is ${where}. Look for the yellow COME IN sign over its front door, and press E there.`
      : "No house near here can be gone into. Most houses open, so try the next street; shops, sheds and big buildings do not.");
  } else if (name === "help") {
    notice("Tab   everything you can do, to click. The buttons along the bottom are the most used; Z hides them and brings them back.");
    notice("M   the little map in the corner: bigger, hidden, and back. It shows friends, doors that open, where trains stop, cars,");
    notice("    and the way to where you are being taken.");
    notice("The same things as typed commands, for those who like typing:");
    notice("G   show me: a list of things to see and do, and you are taken straight to the one you pick");
    notice("    (or /show, and /show train goes at once)");
    notice("/goto <place or lat, lon>   travel anywhere, e.g. /goto Times Square");
    notice("/join <name>   go to someone        /who   who is online and where");
    notice("/home   make where you stand your home (or /home <place>); you start there next time");
    notice("/name <name>   /animal <fox, bear, rabbit, cat, owl or frog>   /room <room>");
    notice("    (your passport, P, has the six animals to choose from too: \"Your animal\")");
    notice("/invite   get a link to send to someone        /where   show your coordinates");
    notice("/fly   toggle flying (also the F key; Space and C go up and down)        /login   /logout");
    notice("/sound on or /sound off   the animals' voices, car horns and tractors");
    notice("/look flat   bright flat colours and bold black lines, like a television cartoon        /look barnyard   the painted look");
    notice("    (/look flat nolines leaves the black line off, for a slow computer)");
    notice("E   hop on a horse, a cow, a tractor, a boat, a car or a passing train; E again hops off");
    notice("V   riding anything, or being carried by a train, a taxi or a friend: look down from above, then from high up,");
    notice("    then back to your seat; the mouse swings the camera round and the wheel brings it nearer or further");
    notice("/taxi <place>   call a taxi; it drives to you, and E beside it gets you a ride there");
    notice("E   at the front door of a house: go in, and E again just inside it to come out");
    notice("    an animal with a thought bubble over it is hungry: talk to it (T) with that food in your lunch box and it is fed;");
    notice("    feeding hungry animals wins new companions");
    notice("/agility   an agility course of nine obstacles in a ring before you, for you and your companion: R starts it,");
    notice("    run it in order (the light shows the next), and your best time is kept; friends can press R to join in");
    notice("C   your car comes to you (not while flying, when C is down)        X   a taxi: it asks where to, comes to you, and drives you there");
    notice("K   tricks for the companion at your side: teach it the next one (a game of timing: Space as each paw print");
    notice("    reaches the ring), and have it do the ones it knows (or /trick spin, /teach)");
    notice("B   your lunch box and your five hearts: eat one of each kind of good food (fruit, vegetables, bread, protein, dairy)");
    notice("    and you are quicker on your feet for the day. Cows, hens, fruit trees, tractors and boats give food when you talk to them,");
    notice("    and beside a real shop or café B shows what it sells: every country has its own dishes");
    notice("H   a house of your own: inside a house nobody lives in, H makes it yours and puts your name over the door;");
    notice("    inside your own, H opens the furniture, paint and prizes; anywhere else, H takes you home (/house moveout gives it up)");
    notice("    and at the bottom of it, a plan of your own: upload a picture of a real floor plan and your house is built from it");
    notice("    the same panel has your garden: a chick, a lamb, a piglet or a calf of your own, fed once a day from your lunch box");
    notice("    until it is grown, and then it gives you an egg, wool, a truffle or milk every day (H by your front door shows it too)");
    notice("    in a car, taxi or tractor you drive: W and S are the pedals, A and D steer, Space is the handbrake,");
    notice("    and the mouse looks round the car");
    notice("T   talk to the animal, car, train, tree or house beside you: it answers in a bubble with a line to type on. Esc finishes.");
    notice("    Tell it what to do, with the buttons in the bubble or in your own words: follow me, come here, stay, go home,");
    notice("    do a trick, make your noise. Riding it: take me to the beach");
    notice("    ask anything \"can I help?\" and it may ask you a favour: a ride, a walk, a hello to pass on");
    notice("Q   ask the guide, in plain words: where am I, what is near here, is there a shop, how do I get to the beach.");
    notice("    Its answer comes with buttons that take you there: a taxi, your ride, or straight there (or /guide <question>)");
    notice("P   your passport (or /passport): today's three tasks, favours you were asked, treasure hunts and expeditions to set out on,");
    notice("    your coins and hats, countries, places, friends,");
    notice("/clue   hear again the clue of the treasure hunt you are on");
    notice("/car    bring your own car to where you are (choose its paint in your passport); /car away sends it off");
    notice("/houses   say where the nearest house you can go into is");
    notice("/herd   a round-up, alone or together: a pen appears where you stand; T beside an animal has it follow you,");
    notice("    and walking it into the pen counts it in");
    notice("/tag and /hide   set up a game of tag, or of hide and seek, where you stand: friends press R to join, and you");
    notice("    press R to start. It takes two. (/tag stop leaves it, or ends your own.)");
    notice("R   a race along the roads here: R sets one up, R joins one a friend has set up, and R starts yours");
    notice("    (/race stop leaves it, or ends your own). Go on foot, on a horse or in a car: every gate in turn.");
    notice("    stamps, your level, riddles to solve");
    notice("    and the companions you have won by solving them");
  } else if (name === "taxi") {
    if (!arg) return notice("Say where to, like this: /taxi the beach");
    if (!meetup.joined) return problem("Not connected to the meetup server.");
    notice(`Calling a taxi to take you to ${arg}...`);
    meetup.sendTaxi(arg);
  } else if (name === "show" || name === "showme") {
    if (arg) void showcase.go(arg);
    else void showcase.toggle();
  } else if (name === "passport" || name === "journal") {
    passport.toggle();
  } else if (name === "tag" || name === "hide" || name === "herd") {
    if (!meetup.joined) return problem("Not connected to the meetup server.");
    if (arg.toLowerCase() === "stop") play.stop();
    else play.make(name);
  } else if (name === "agility") {
    races.agility();
  } else if (name === "race") {
    if (!meetup.joined) return problem("Not connected to the meetup server.");
    races.key(arg.toLowerCase());
  } else if (name === "car") {
    if (!meetup.joined) return problem("Not connected to the meetup server.");
    if (arg.toLowerCase() === "away") {
      notice("Your car has gone back to where it waits.");
      return meetup.sendCarAway();
    }
    notice("Your car is on its way. Press E beside it to get in.");
    meetup.callCar();
  } else if (name === "clue") {
    if (!meetup.joined) return problem("Not connected to the meetup server.");
    wantClue = true;
    meetup.requestJournal();
  } else if (name === "teach") {
    train.teach();
  } else if (name === "trick" || name === "tricks") {
    if (!arg) train.toggle();
    else if (!train.perform(arg)) meetup.sendTrick({ do: arg.toLowerCase() });
  } else if (name === "lunch" || name === "food") {
    lunch.toggle();
  } else if (name === "house") {
    if (/^(move ?out|leave)$/i.test(arg ?? "")) houses.moveOut();
    else houses.home();
  } else if (name === "goto" && arg) {
    // In a car or on an animal, "Go to" is said to it: it carries me there, along the road when the place is close.
    if (riding.mine && riding.mine.seat === 0 && CARRIERS.has(riding.mine.sp) && talk.beginRide()) {
      openTalk();
      talkSay(`take me to ${arg}`); // it answers in its bubble
      return;
    }
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
    const names = [...meetup.peers.values()].map((p) => {
      // And how far off each is, as the crow flies.
      const at = p.hasPosition ? world.geoToScene(p.lat, p.lon) : null;
      return at ? `${p.name} (${far(Math.hypot(at.x - player.position.x, at.z - player.position.z))} away)` : p.name;
    });
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
    notice(key === "avatar" ? `You are ${/^[aeiou]/.test(hello.avatar) ? "an" : "a"} ${hello.avatar} now.` : "Saved. Reconnecting...");
    if (key === "avatar" && riding.mine) riding.off(); // step down first: the change is a quick leaving and coming back
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
window.earthwalk = { menu, guide, menuAction, openTalk, talkSay, openNews, minimap, look, ink, sky, scene, camera, renderer, world, player, meetup, avatars, life, traffic, riding, talk, orders, houses, decor, lunch, train, care, garden, taxis, pets, treasure, garage, races, play, sounds, showcase, command, isStarted: () => started };
