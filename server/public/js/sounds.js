// Sounds, made by code like everything else in EarthWalk: there are no recordings. Each call is a
// short tune for an oscillator, shaped by filters, and placed in the world so it comes from the animal.

const MAX_VOICES = 6;
/** How loud each call is against the others. */
const LOUDNESS = { moo: 1, baa: 0.7, neigh: 0.8, cluck: 0.3, squawk: 0.45 };

export class Sounds {
  constructor() {
    this.enabled = true;
    this.ctx = null;
    this.voices = 0;
    /** How many calls have been played, for the tests. */
    this.played = 0;
  }

  /** Browsers only allow sound after a click or a key press, so call this from one. */
  unlock() {
    if (!this.ctx) {
      const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
      if (!AudioCtx) return;
      this.ctx = new AudioCtx();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.7;
      const limiter = this.ctx.createDynamicsCompressor();
      this.master.connect(limiter).connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => undefined);
  }

  get ready() {
    return this.enabled && this.ctx?.state === "running";
  }

  /** Put the listener's ears where the camera is. */
  listen(camera) {
    if (!this.ready) return;
    const l = this.ctx.listener;
    const p = camera.position;
    const e = camera.matrixWorld.elements; // columns: right, up, back
    if (l.positionX) {
      l.positionX.value = p.x; l.positionY.value = p.y; l.positionZ.value = p.z;
      l.forwardX.value = -e[8]; l.forwardY.value = -e[9]; l.forwardZ.value = -e[10];
      l.upX.value = e[4]; l.upY.value = e[5]; l.upZ.value = e[6];
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(-e[8], -e[9], -e[10], e[4], e[5], e[6]);
    }
  }

  /**
   * Plays one call at a place in the scene. `pitch` near 1 makes each animal's voice its own.
   * @param {"moo" | "baa" | "neigh" | "cluck" | "squawk"} kind
   * @returns {boolean} false when sound is off, not yet allowed, or too much is already playing
   */
  play(kind, x, y, z, pitch = 1) {
    if (!this.ready || this.voices >= MAX_VOICES || !VOICES[kind]) return false;
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = LOUDNESS[kind];
    const panner = new PannerNode(ctx, {
      panningModel: "equalpower", distanceModel: "inverse", refDistance: 5, maxDistance: 300, rolloffFactor: 1.5,
      positionX: x, positionY: y, positionZ: z,
    });
    out.connect(panner).connect(this.master);
    const seconds = VOICES[kind](ctx, out, ctx.currentTime + 0.02, pitch);
    this.voices++;
    this.played++;
    setTimeout(() => { this.voices--; panner.disconnect(); }, seconds * 1000 + 200);
    return true;
  }
}

/** One note: an oscillator whose pitch and loudness follow the given points [seconds, value]. */
function note(ctx, out, t0, { type, pitch, level, chain = [], vibrato = null, tremolo = null }) {
  const end = t0 + level[level.length - 1][0];
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(pitch[0][1], t0);
  for (const [at, hz] of pitch.slice(1)) osc.frequency.exponentialRampToValueAtTime(hz, t0 + at);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0, t0);
  for (const [at, v] of level) gain.gain.linearRampToValueAtTime(v, t0 + at);
  const wobble = (hz, depth, target) => {
    const lfo = ctx.createOscillator();
    const amount = ctx.createGain();
    lfo.frequency.value = hz;
    amount.gain.value = depth;
    lfo.connect(amount).connect(target);
    lfo.start(t0);
    lfo.stop(end);
  };
  if (vibrato) wobble(vibrato[0], vibrato[1], osc.frequency);
  let node = osc;
  for (const [kind, hz, q, sweep] of chain) {
    const filter = ctx.createBiquadFilter();
    filter.type = kind;
    filter.frequency.setValueAtTime(hz, t0);
    filter.Q.value = q;
    for (const [at, to] of sweep ?? []) filter.frequency.exponentialRampToValueAtTime(to, t0 + at);
    node = node.connect(filter);
  }
  if (tremolo) {
    const shake = ctx.createGain();
    shake.gain.value = 1 - tremolo[1] / 2;
    wobble(tremolo[0], tremolo[1] / 2, shake.gain);
    node = node.connect(shake);
  }
  node.connect(gain).connect(out);
  osc.start(t0);
  osc.stop(end + 0.05);
}

const cluck = (ctx, out, t0, p, level = 0.8) => note(ctx, out, t0, {
  type: "square", pitch: [[0, 430 * p], [0.03, 840 * p], [0.08, 500 * p]], level: [[0.008, level], [0.09, 0]],
  chain: [["bandpass", 1000 * p, 2]],
});

/** Each voice schedules its notes and returns how long it lasts, in seconds. */
const VOICES = {
  // "Mmm-ooo": a low buzz that opens up and sinks away.
  moo(ctx, out, t0, p) {
    note(ctx, out, t0, {
      type: "sawtooth", pitch: [[0, 96 * p], [0.18, 150 * p], [0.9, 136 * p], [1.6, 100 * p]],
      level: [[0.12, 0.9], [1.1, 0.8], [1.6, 0]], vibrato: [5.5, 3],
      chain: [["lowpass", 340, 3, [[0.3, 900], [1.6, 480]]], ["peaking", 620, 2]],
    });
    return 1.6;
  },
  // A quavering "baa".
  baa(ctx, out, t0, p) {
    note(ctx, out, t0, {
      type: "sawtooth", pitch: [[0, 335 * p], [0.75, 300 * p]], level: [[0.04, 0.9], [0.55, 0.8], [0.78, 0]],
      vibrato: [8, 12], tremolo: [8, 0.9], chain: [["bandpass", 950, 1.2], ["lowpass", 2600, 0.7]],
    });
    return 0.8;
  },
  // A whinny: up fast, then tumbling down with a shake in it.
  neigh(ctx, out, t0, p) {
    note(ctx, out, t0, {
      type: "sawtooth", pitch: [[0, 520 * p], [0.12, 1150 * p], [0.45, 900 * p], [1.1, 420 * p]],
      level: [[0.05, 0.8], [0.6, 0.7], [1.15, 0]], vibrato: [13, 70], tremolo: [13, 0.6],
      chain: [["bandpass", 1400, 1]],
    });
    return 1.2;
  },
  cluck(ctx, out, t0, p) {
    cluck(ctx, out, t0, p);
    cluck(ctx, out, t0 + 0.14, p * 1.06);
    cluck(ctx, out, t0 + 0.3, p * 0.97);
    return 0.45;
  },
  // A startled hen: one long squawk, then indignant clucking.
  squawk(ctx, out, t0, p) {
    note(ctx, out, t0, {
      type: "square", pitch: [[0, 620 * p], [0.08, 1300 * p], [0.28, 720 * p]], level: [[0.01, 0.9], [0.2, 0.7], [0.3, 0]],
      tremolo: [32, 0.8], chain: [["bandpass", 1300 * p, 1.5]],
    });
    for (let i = 0; i < 4; i++) cluck(ctx, out, t0 + 0.36 + i * 0.11, p * (1.1 - i * 0.04), 0.7);
    return 0.9;
  },
};
