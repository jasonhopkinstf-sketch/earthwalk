// The weather, drawn and heard: clouds, rain, snow, fog and wind in the game's own cartoon style.
// What the weather is comes from the server (`GET /v1/weather`, which asks Open-Meteo for the
// district); what each kind of weather does is numbers in weatherdata.js. This draws them:
//
// - Rain is short pale streaks and snow is round white flakes, in a box of air that stays round the
//   camera: a streak that leaves one side comes in at the other, so the same few thousand are always
//   near. They are drawn solid (no see-through), slanted and carried by the wind.
// - Leaves blow along on a very windy day; the trees lean in the gusts (sway.js); the clouds cross
//   the sky faster (look.js).
// - Cloud, the grey of an overcast sky and fog are handed to the sky and the light (daynight.js).
// - Rain and wind are sounds made here from hiss, shaped by filters: no recordings (as sounds.js).
//   Under a roof or in a tunnel nothing falls and the rain is heard muffled.
//
// Two settings, kept on this device: "real" (the real weather of where the player is) and "fine" (the
// fine day the game always had). And kinds of weather to try out for one visit ("/weather snow").
// When the server has no weather to give, it is a fine day and nothing is said: the game goes on.

import * as THREE from "three";
import { LAYER, inkMark } from "./look.js";
import { wind } from "./sway.js";
import { FALL_BOX, FINE, MOST, TRY, weatherLook, weatherSaid } from "./weatherdata.js";

/** How often the server is asked, and how soon after a failure. */
const ASK_EVERY_MS = 10 * 60_000;
const ASK_AGAIN_MS = 2 * 60_000;
/** The district a position is in: the same quarter of a degree the server rounds to, so no more than that is ever sent. */
const areaOf = (v) => Math.round(v * 4) / 4;

const FALL_VERTEX = `
uniform vec3 uBox;
uniform vec3 uTravel;
uniform vec3 uDir;
uniform float uLen;
uniform float uWidth;
uniform float uSway;
uniform float uTime;
attribute vec2 corner;
varying vec2 vAt;
void main() {
  // Each falls at its own pace: one of four, each of which crosses the box a whole number of times while the
  // slowest crosses it three times, so the travel can be counted round and round without a jump.
  float pace = 0.75 + 0.25 * floor(fract(position.x * 7.31) * 4.0);
  vec3 p = position * uBox + uTravel * pace;
  p.xz += uSway * vec2(sin(uTime * 1.3 + position.y * 40.0), cos(uTime * 1.1 + position.z * 40.0));
  // The box of air stays round the camera: what leaves one side comes in at the other.
  p = mod(p - cameraPosition, uBox) - 0.5 * uBox + cameraPosition;
  vec3 along, side;
  if (uLen > 0.0) {
    // A streak: as long as it falls in a moment, and turned to face the eye.
    along = uDir * uLen;
    side = normalize(cross(uDir, normalize(cameraPosition - p))) * uWidth;
  } else {
    // A flake or a leaf: a small square facing the camera.
    side = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]) * uWidth;
    along = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]) * uWidth * 2.0;
  }
  vAt = vec2(corner.x, corner.y * 2.0 - 1.0);
  gl_Position = projectionMatrix * viewMatrix * vec4(p + along * (corner.y - (uLen > 0.0 ? 0.0 : 0.5)) + side * corner.x, 1.0);
  // Nothing right in the eye.
  if (distance(p, cameraPosition) < 1.8) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}`;
const FALL_FRAGMENT = `
uniform vec3 uColor;
uniform float uRound;
uniform float uMarking;
varying vec2 vAt;
void main() {
  if (uRound > 0.5 && dot(vAt, vAt) > 1.0) discard;
  // (The half says to the ink pass that this gets no black line: look.js.)
  gl_FragColor = vec4(uColor, mix(1.0, 0.5, uMarking));
  #include <colorspace_fragment>
}`;

/** One kind of thing that falls or blows through the box of air round the camera. */
class Fall {
  constructor(scene, most, { round = false } = {}) {
    const seeds = new Float32Array(most * 12), corners = new Float32Array(most * 8), index = new Uint32Array(most * 6);
    let rng = 12345;
    const next = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 4294967296);
    for (let i = 0; i < most; i++) {
      const seed = [next(), next(), next()];
      for (let k = 0; k < 4; k++) {
        seeds.set(seed, i * 12 + k * 3);
        corners.set([k % 2 ? 1 : -1, k < 2 ? 0 : 1], i * 8 + k * 2);
      }
      index.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4 + 2, i * 4 + 1, i * 4 + 3], i * 6);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(seeds, 3));
    geometry.setAttribute("corner", new THREE.BufferAttribute(corners, 2));
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    this.uniforms = {
      uBox: { value: new THREE.Vector3(...FALL_BOX) }, uTravel: { value: new THREE.Vector3() }, uDir: { value: new THREE.Vector3(0, -1, 0) },
      uLen: { value: 0 }, uWidth: { value: 0.02 }, uSway: { value: 0 }, uTime: { value: 0 }, uColor: { value: new THREE.Color(1, 1, 1) }, uRound: { value: round ? 1 : 0 }, uMarking: inkMark,
    };
    this.mesh = new THREE.Mesh(geometry, new THREE.ShaderMaterial({ uniforms: this.uniforms, vertexShader: FALL_VERTEX, fragmentShader: FALL_FRAGMENT, side: THREE.DoubleSide }));
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.layers.set(LAYER.sky); // in the view with the world, and not on the little map
    scene.add(this.mesh);
    this.most = most;
    this.travel = new THREE.Vector3(); // how far they have all gone, counted round and round in doubles
  }

  /** `count` of them, moving at `velocity` (metres a second: east, up, south). */
  frame(dt, count, velocity) {
    const n = Math.min(this.most, Math.round(count));
    this.mesh.visible = n > 0;
    if (!n) return;
    this.mesh.geometry.setDrawRange(0, n * 6);
    const box = this.uniforms.uBox.value, travel = this.travel;
    travel.set((travel.x + velocity.x * dt) % (box.x * 4), (travel.y + velocity.y * dt) % (box.y * 4), (travel.z + velocity.z * dt) % (box.z * 4));
    this.uniforms.uTravel.value.copy(travel);
    this.uniforms.uDir.value.copy(velocity).normalize();
  }
}

/** Hiss shaped by filters into rain and wind, and a far rumble for thunder. Built the first time sound is allowed. */
class WeatherSounds {
  constructor(sounds) {
    this.sounds = sounds;
    this.built = false;
  }

  build() {
    const ctx = this.sounds.ctx;
    const hiss = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
    const data = hiss.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    this.hiss = hiss;
    const loop = () => {
      const source = ctx.createBufferSource();
      source.buffer = hiss;
      source.loop = true;
      source.start(0, Math.random() * 2);
      return source;
    };
    // Rain: the hiss with its bottom cut away, and a lid that comes down under a roof.
    const rainHigh = ctx.createBiquadFilter(), rainLid = ctx.createBiquadFilter(), rainGain = ctx.createGain();
    rainHigh.type = "highpass";
    rainHigh.frequency.value = 700;
    rainLid.type = "lowpass";
    rainLid.frequency.value = 6500;
    rainGain.gain.value = 0;
    loop().connect(rainHigh).connect(rainLid).connect(rainGain).connect(this.sounds.master);
    // Wind: a band of the hiss whose pitch wanders slowly up and down, and swells in gusts.
    const windBand = ctx.createBiquadFilter(), windGain = ctx.createGain(), gusts = ctx.createGain();
    windBand.type = "bandpass";
    windBand.frequency.value = 420;
    windBand.Q.value = 0.9;
    windGain.gain.value = 0;
    gusts.gain.value = 0.7;
    for (const [hz, depth, target] of [[0.11, 170, windBand.frequency], [0.29, 90, windBand.frequency], [0.17, 0.3, gusts.gain]]) {
      const slow = ctx.createOscillator(), amount = ctx.createGain();
      slow.frequency.value = hz;
      amount.gain.value = depth;
      slow.connect(amount).connect(target);
      slow.start();
    }
    loop().connect(windBand).connect(gusts).connect(windGain).connect(this.sounds.master);
    Object.assign(this, { rainLid, rainGain, windGain, built: true });
  }

  /** `rain` and `wind` are how loud, 0 to 1; `muffled` under a roof or in a tunnel. */
  set(rain, wind, muffled) {
    if (!this.sounds.ready) {
      if (this.built && this.sounds.ctx) for (const gain of [this.rainGain, this.windGain]) gain.gain.setTargetAtTime(0, this.sounds.ctx.currentTime, 0.2);
      return;
    }
    if (!this.built) this.build();
    const now = this.sounds.ctx.currentTime;
    this.rainGain.gain.setTargetAtTime(rain * (muffled ? 0.09 : 0.16), now, 0.6);
    this.rainLid.frequency.setTargetAtTime(muffled ? 800 : 6500, now, 0.4);
    this.windGain.gain.setTargetAtTime(wind * (muffled ? 0.07 : 0.22), now, 0.8);
  }

  /** A roll of thunder, a few seconds long: the hiss with everything but its deepest part taken out. */
  thunder(loud = 1) {
    if (!this.sounds.ready || !this.built) return;
    const ctx = this.sounds.ctx, t0 = ctx.currentTime + 0.05;
    const source = ctx.createBufferSource(), low = ctx.createBiquadFilter(), gain = ctx.createGain();
    source.buffer = this.hiss;
    low.type = "lowpass";
    low.frequency.setValueAtTime(260, t0);
    low.frequency.exponentialRampToValueAtTime(70, t0 + 2.6);
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(0.5 * loud, t0 + 0.08);
    gain.gain.linearRampToValueAtTime(0.22 * loud, t0 + 0.7);
    gain.gain.linearRampToValueAtTime(0.3 * loud, t0 + 1.1);
    gain.gain.linearRampToValueAtTime(0, t0 + 2.9);
    source.connect(low).connect(gain).connect(this.sounds.master);
    source.start(t0, Math.random());
    source.stop(t0 + 3);
  }
}

const NUMBERS = ["clouds", "veil", "mist", "fogNear", "fogFar", "windX", "windZ", "drift", "sway", "rainSound", "windSound"];

export class Weather {
  /**
   * @param {{ scene: THREE.Scene, sounds: import("./sounds.js").Sounds, sky: import("./look.js").Sky, credit: HTMLElement | null,
   *   code: () => string, setting?: string }} parts  `code` gives the access code for the server; `credit` is where the map's credit is shown
   */
  constructor({ scene, sounds, sky, credit, code, setting }) {
    Object.assign(this, { sky, code });
    /** "real" or "fine". */
    this.setting = setting === "fine" ? "fine" : "real";
    /** A kind of weather being tried out, or null. */
    this.trying = null;
    /** The last report the server gave, and the district it was for. */
    this.report = null;
    this.area = "";
    this.askAt = 0;
    /** The weather in force. */
    this.now = FINE;
    this.goal = weatherLook(FINE);
    /** What is being drawn this moment: the goal, come to gradually, so the weather turns and does not snap. */
    this.look = weatherLook(FINE);
    this.rainCount = 0;
    this.snowCount = 0;
    this.leafCount = 0;
    this.sheltered = false;
    this.daylight = 1;
    this.flash = 0;
    this.nextFlash = 0;
    this.rain = new Fall(scene, MOST.rain);
    this.snow = new Fall(scene, MOST.snow, { round: true });
    this.leaves = new Fall(scene, MOST.leaves);
    this.audio = new WeatherSounds(sounds);
    this.time = 0;
    // "Weather data by Open-Meteo.com", beside the map's credit, while their weather is what is shown.
    this.credit = null;
    if (credit) {
      this.credit = document.createElement("span");
      this.credit.hidden = true;
      this.credit.append(" · ");
      credit.append(this.credit);
    }
  }

  /** "real", "fine", or a kind of weather to try out; false for anything else. */
  set(name) {
    if (name === "real" || name === "fine") {
      this.setting = name;
      this.trying = null;
      if (name === "real") this.askAt = 0; // asked afresh
    } else if (name in TRY) this.trying = name;
    else return false;
    this.choose();
    return true;
  }

  /** Is the weather the real one just now? */
  get real() {
    return this.setting === "real" && !this.trying && !!this.report;
  }

  choose() {
    this.now = this.trying ? TRY[this.trying] : this.setting === "real" && this.report ? this.report : FINE;
    this.goal = weatherLook(this.now);
    if (this.credit) {
      const show = this.real;
      if (show && this.credit.childNodes.length < 2) {
        const link = Object.assign(document.createElement("a"), { href: this.report.creditUrl, target: "_blank", rel: "noopener", textContent: this.report.credit });
        this.credit.append(link);
      }
      this.credit.hidden = !show;
    }
  }

  /** Asks the server for the weather of the district round a place, when it is time to. Never throws; a failure is a fine day. */
  async ask(place, nowMs) {
    const lat = areaOf(place.lat), lon = areaOf(place.lon);
    const area = `${lat},${lon}`;
    if (this.setting !== "real" || this.asking || (area === this.area && nowMs < this.askAt)) return;
    this.asking = true;
    let report = null;
    try {
      const token = this.code();
      const res = await fetch(`/v1/weather?lat=${lat}&lon=${lon}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      const body = res.ok ? await res.json() : null;
      if (body && typeof body.kind === "string" && typeof body.cloud === "number") report = body;
    } catch { /* a fine day */ }
    this.asking = false;
    // (A district the server has nothing for is a fine day, not the last district's rain.)
    this.report = report ?? (area === this.area ? this.report : null);
    this.area = area;
    this.askAt = nowMs + (report ? ASK_EVERY_MS : ASK_AGAIN_MS);
    this.choose();
  }

  /**
   * A few times a second. `place` is { lat, lon } or null while the player has not landed; `sheltered` is true under a
   * roof or in a tunnel; `daylight` is 0 at night to 1 by day. Returns the weather's part of the sky and the light.
   */
  tick(dt, place, nowMs, sheltered, daylight) {
    if (place) void this.ask(place, nowMs);
    this.sheltered = sheltered;
    this.daylight = daylight;
    // The weather turns over some seconds: it does not snap.
    const k = 1 - Math.exp(-dt / 2.5);
    for (const name of NUMBERS) this.look[name] += (this.goal[name] - this.look[name]) * k;
    const settle = (have, want) => (Math.abs(want - have) < 2 ? want : have + (want - have) * k);
    this.rainCount = settle(this.rainCount, this.goal.rain.count);
    this.snowCount = settle(this.snowCount, this.goal.snow.count);
    this.leafCount = settle(this.leafCount, this.goal.leaves.count);
    if (this.goal.rain.count) this.look.rain = this.goal.rain;
    this.sky.pace = this.look.drift;
    wind.sway.value = this.look.sway;
    const blow = Math.hypot(this.look.windX, this.look.windZ);
    if (blow > 0.01) wind.dir.value.set(this.look.windX / blow, this.look.windZ / blow);
    this.audio.set(this.look.rainSound, this.look.windSound, sheltered);
    // Lightning: a flash or two now and then, and the thunder after it.
    if (this.goal.thunder && this.rainCount > 500) {
      if (!this.nextFlash) this.nextFlash = nowMs + 3000 + Math.random() * 6000;
      if (nowMs >= this.nextFlash) {
        this.nextFlash = nowMs + 7000 + Math.random() * 14000;
        this.flash = 1;
        setTimeout(() => { this.flash = Math.max(this.flash, 0.8); }, 180);
        setTimeout(() => this.audio.thunder(sheltered ? 0.5 : 1), 600 + Math.random() * 2200);
      }
    } else this.nextFlash = 0;
    this.flash *= Math.exp(-dt / 0.12);
    if (this.flash < 0.01) this.flash = 0;
    return this.look;
  }

  /** Every frame: the rain, the snow and the leaves move on. */
  frame(dt) {
    this.time += dt;
    wind.time.value = this.time;
    const look = this.look, out = this.sheltered ? 0 : 1;
    const dim = 0.4 + 0.6 * this.daylight;
    const velocity = new THREE.Vector3();
    this.rain.uniforms.uLen.value = look.rain.length;
    this.rain.uniforms.uWidth.value = look.rain.width;
    this.rain.uniforms.uColor.value.setRGB(0.62 * dim, 0.74 * dim, 0.92 * dim);
    this.rain.frame(dt, this.rainCount * out, velocity.set(look.windX * 0.8, -look.rain.speed, look.windZ * 0.8));
    this.snow.uniforms.uWidth.value = look.snow.size;
    this.snow.uniforms.uSway.value = look.snow.sway;
    this.snow.uniforms.uTime.value = this.time;
    this.snow.uniforms.uColor.value.setRGB(dim, dim, dim);
    this.snow.frame(dt, this.snowCount * out, velocity.set(look.windX * 0.6, -look.snow.speed, look.windZ * 0.6));
    this.leaves.uniforms.uWidth.value = 0.07;
    this.leaves.uniforms.uSway.value = 0.6;
    this.leaves.uniforms.uTime.value = this.time * 2.2;
    this.leaves.uniforms.uColor.value.setRGB(0.50 * dim, 0.42 * dim, 0.10 * dim);
    this.leaves.frame(dt, this.leafCount * out, velocity.set(look.windX * 0.9, -0.5, look.windZ * 0.9));
  }

  /** The weather in plain words, for the chat window. */
  said() {
    const words = weatherSaid(this.now);
    if (this.trying) return `Trying out ${this.trying}: ${words}. /weather real goes back to the real weather, and /weather fine to a fine day.`;
    if (this.setting === "fine") return "It is always a fine day here. /weather real has the real weather of wherever you are.";
    return this.report ? `The real weather here: ${words}. (${this.report.credit})` : "The real weather could not be had just now, so it is a fine day. It is asked for again in a couple of minutes.";
  }
}
