// EarthWalk in the browser: join screen, the world, other players, chat and commands.

import * as THREE from "three";
import { ANIMALS, Avatars } from "./avatars.js";
import { Meetup } from "./net.js";
import { Player } from "./player.js";
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
let started = false;

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
pick(saved.avatar ?? ANIMALS[Math.floor(Math.random() * ANIMALS.length)].id);
$("name").value = saved.name ?? "";
$("room").value = params.get("room") ?? saved.room ?? "family";
$("code").value = params.get("code") ?? saved.code ?? "";
const joinError = $("join-error");

fetch("/health").then((r) => r.json()).then((health) => {
  // Only ask for a code when this server needs one (or the invite link carried one).
  $("code-row").hidden = !health.codeRequired && !$("code").value;
}).catch(() => { joinError.textContent = "The world server is not answering. Try again in a moment."; });

$("join").addEventListener("submit", (e) => {
  e.preventDefault();
  const hello = {
    name: $("name").value.trim(),
    room: $("room").value.trim() || "family",
    avatar: animals.querySelector("input:checked").value,
    code: $("code").value.trim(),
  };
  if (!hello.name) return;
  joinError.textContent = "";
  $("go").disabled = true;
  $("go").textContent = "Joining...";
  save(hello);
  world.code = hello.code;
  meetup.connect(hello);
});

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
  if (!started) start();
  notice(`You are ${me.name} in room "${me.room}". ${others.length ? `Here now: ${others.join(", ")}.` : "Nobody else is here yet."}`);
  for (const line of history) addLine(line.text, "", line.name);
});

// ---------------------------------------------------------------- the world
function start() {
  started = true;
  $("join").hidden = true;
  $("hud").hidden = false;
  history.replaceState(null, "", location.pathname); // keep the access code out of the address bar
  const lat = parseFloat(params.get("lat") ?? saved.lat ?? "48.8583");
  const lon = parseFloat(params.get("lon") ?? saved.lon ?? "2.2945");
  player.travelTo(Number.isFinite(lat) ? lat : 48.8583, Number.isFinite(lon) ? lon : 2.2945);
  notice("Welcome to EarthWalk. Try /goto Sydney Opera House, or /help.");
  setInterval(tickSlow, 100);
  renderer.setAnimationLoop(frame);
}

let last = performance.now();
function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  player.update(dt);
  avatars.update(dt, meetup.peers, world);
  renderer.render(scene, camera);
}

let slowTicks = 0;
function tickSlow() {
  slowTicks++;
  world.update(player.position);
  const here = world.sceneToGeo(player.position);
  if (!player.waitingForGround) meetup.sendPosition(here.lat, here.lon, here.alt, player.heading);
  if (slowTicks % 5 === 0) {
    const parts = [`${here.lat.toFixed(5)}, ${here.lon.toFixed(5)}`];
    if (player.flying) parts.push("flying");
    if (player.waitingForGround) parts.push(world.lastError || "building the world here...");
    parts.push(meetup.joined ? `room "${meetup.me.room}": ${meetup.peers.size + 1} here` : "meetup server: not connected");
    $("status").textContent = parts.join("  |  ");
  }
  if (slowTicks % 50 === 0 && !player.waitingForGround) save({ lat: here.lat, lon: here.lon });
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

async function command(name, arg) {
  if (name === "help") {
    notice("/goto <place or lat, lon>   travel anywhere, e.g. /goto Times Square");
    notice("/join <name>   go to someone in your room        /who   list who is here");
    notice("/invite   get a link to send to someone        /where   show your coordinates");
    notice("/fly   toggle flying (also the F key; Space and C go up and down)");
  } else if (name === "goto" && arg) {
    notice(`Looking for "${arg}"...`);
    try {
      const res = await fetch(`/v1/geocode?q=${encodeURIComponent(arg)}`, { headers: world.code ? { Authorization: `Bearer ${world.code}` } : {} });
      if (!res.ok) return problem(`Could not find "${arg}". Try a fuller name, or coordinates like 48.8583, 2.2945.`);
      const place = await res.json();
      notice(`Travelling to ${place.name}`);
      player.travelTo(place.lat, place.lon);
    } catch {
      problem("Could not reach the world server to look that up.");
    }
  } else if (name === "join" && arg) {
    const peer = meetup.findPeer(arg);
    if (!peer) problem(`Nobody called "${arg}" is in this room. Type /who to see who is here.`);
    else if (!peer.hasPosition) problem(`${peer.name} has not arrived anywhere yet. Try again in a moment.`);
    else {
      notice(`Travelling to ${peer.name}...`);
      player.travelTo(peer.lat + 0.00003, peer.lon); // arrive a few metres away, not on top of them
    }
  } else if (name === "who") {
    const names = [...meetup.peers.values()].map((p) => p.name);
    notice(names.length ? `Here with you: ${names.join(", ")}` : "Nobody else is in this room right now.");
  } else if (name === "where") {
    const here = world.sceneToGeo(player.position);
    notice(`You are at ${here.lat.toFixed(6)}, ${here.lon.toFixed(6)}, ${Math.round(here.alt)} m above sea level.`);
  } else if (name === "fly") {
    player.setFlying(!player.flying);
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
window.earthwalk = { world, player, meetup, avatars, command, isStarted: () => started };
