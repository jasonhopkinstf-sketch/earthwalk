// How the world is drawn: the look in use, the one place that makes its materials, the sky, and the
// black line of the flat look. The numbers are lookdata.js's, which are the Windows game's.
//
// - Every lit material is made by `paint`. In the barnyard look it takes the light as before. In the
//   flat look the same material is drawn in its own colour at one of three even levels, by how
//   squarely it faces the sun, with no gradients; the world's surfaces are also made a little more
//   vivid, and the ground takes the flat look's own palette (world.js). One switch turns every
//   material over at once, so "/look flat" changes the picture where the player stands.
// - `Sky` is a great ball round the camera with the sky painted inside it: pale at the horizon and
//   deep overhead, a drawn sun, rows of flat-bottomed clouds drifting, and far country in haze below
//   the horizon where the land has run out. In the flat look it is one blue with plain white clouds.
// - `Ink` draws the flat look's line: the world is drawn into a picture with its depths, and a
//   second pass over the whole screen paints black wherever the depth bends sharply (the edge of a
//   thing) or the colour steps (one paint meeting another). It costs a pass over every pixel, so it
//   can be left off ("/look flat nolines").

import * as THREE from "three";
import { FLAT, FLAT_GROUND, SKY, flatLevels, parseLook } from "./lookdata.js";

/** What is drawn when: the world; names and speech bubbles, over everything and never inked; the sky, which the little map leaves out. */
export const LAYER = { world: 0, over: 1, sky: 2 };

/** The look in use. `lines`: whether the flat look has its black line. */
export const look = { name: "barnyard", lines: true };
const flat = { value: 0 };
const vividness = { value: 0 };
const none = { value: 0 };
const marking = { value: 0 }; // 1 while the world is being drawn into the picture the line is worked out from
const listeners = [];

/** Told whenever the look changes: (look) => void. */
export function onLook(fn) {
  listeners.push(fn);
}

export function setLook(name, lines) {
  look.name = name === "flat" ? "flat" : "barnyard";
  if (lines !== undefined) look.lines = !!lines;
  flat.value = look.name === "flat" ? 1 : 0;
  vividness.value = look.name === "flat" ? FLAT.vivid : 0;
  for (const fn of listeners) fn(look);
}

// Where a visit starts: the look kept on this device, or "?look=flat" for this visit only.
{
  let kept = {};
  try { kept = JSON.parse(globalThis.localStorage?.getItem("earthwalk") ?? "{}"); } catch { /* the normal look */ }
  const asked = parseLook(new URLSearchParams(globalThis.location?.search ?? "").get("look"));
  setLook(asked?.name ?? kept.look, asked?.lines ?? kept.lines !== "off");
}

const [L0, L1, L2] = flatLevels().map((n) => n.toFixed(4));
const FLAT_LIGHT = `
#if NUM_DIR_LIGHTS > 0
  if (uFlat > 0.0) {
    // The flat look: the surface's own colour at one of three levels, by how squarely it faces the sun.
    float facingSun = dot(normal, directionalLights[0].direction);
    float soft = max(fwidth(facingSun), 0.004);
    float level = mix(mix(${L0}, ${L1}, smoothstep(${FLAT.band1.toFixed(3)} - soft, ${FLAT.band1.toFixed(3)} + soft, facingSun)), ${L2}, smoothstep(${FLAT.band2.toFixed(3)} - soft, ${FLAT.band2.toFixed(3)} + soft, facingSun));
    outgoingLight = mix(outgoingLight, diffuseColor.rgb * level, uFlat);
  }
#endif
`;
const VIVID = `
  {
    // Vivid: the colour brighter than it was sent (nothing in the barnyard look).
    float grey = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = max(mix(vec3(grey), diffuseColor.rgb, 1.0 + uVivid), 0.0);
  }
`;

/**
 * A material for anything the light falls on. `parameters` are MeshLambertMaterial's. `world` is true
 * for the ground, buildings and trees, which the flat look also makes more vivid. `patch` is the
 * material's own change to its shader, if it has one (windows in a wall, a car's paint).
 */
export function paint(parameters = {}, { world = false, patch = null } = {}) {
  const material = new THREE.MeshLambertMaterial(parameters);
  material.onBeforeCompile = (shader) => {
    patch?.(shader);
    shader.uniforms.uFlat = flat;
    shader.uniforms.uVivid = world ? vividness : none;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uFlat;\nuniform float uVivid;")
      .replace("#include <color_fragment>", `#include <color_fragment>\n${VIVID}`)
      .replace("#include <opaque_fragment>", `${FLAT_LIGHT}\n#include <opaque_fragment>`);
  };
  // (three.js tells shaders apart by the text of this function, which is the same for every material here.)
  material.customProgramCacheKey = () => `paint:${world ? 1 : 0}:${patch ? patch.toString() : ""}`;
  return material;
}

/**
 * A material with a picture of its own on it (the words on a sign) that the black line is not to go over:
 * the line is drawn round the board, not on its letters. It says so to the ink pass by leaving the
 * fourth number of the picture the line is worked out from, which nothing else uses, at nought.
 * (Only in that picture: on the screen itself that number is how solid the page is.)
 */
export function unlined(material) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uMarking = marking;
    shader.fragmentShader = shader.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform float uMarking;")
      .replace("#include <dithering_fragment>", "#include <dithering_fragment>\n\tgl_FragColor.a *= 1.0 - uMarking;");
  };
  material.customProgramCacheKey = () => "unlined";
  return material;
}

/** The colour of a surface of the world in the look in use: the flat look has its own for each kind of ground. `sent` is [r, g, b] in screen colour, 0 to 1. */
export function surfaceColor(id, sent, into = new THREE.Color()) {
  const own = look.name === "flat" ? FLAT_GROUND[id] : undefined;
  return own !== undefined ? into.setHex(own) : into.setRGB(sent[0], sent[1], sent[2], THREE.SRGBColorSpace);
}

/** The colour of the haze far country sinks into: what the sky paints just under the horizon. Fog takes it, so the land's edge meets the sky. */
export const HAZE = new THREE.Color().setRGB(0.4 * SKY.bright, 0.66 * SKY.bright, 0.66 * SKY.bright);

// ---------------------------------------------------------------- the sky
// (Colours here are amounts of light, not screen colours, so they look darker written down than they come out.)
const SKY_SHADER = `
uniform vec3 uSun;
uniform float uTime;
uniform float uFlat;
uniform float uCloudInk;
varying vec3 vDir;
const float BRIGHT = ${SKY.bright.toFixed(3)};
const float CLOUD_BRIGHT = ${SKY.cloudBright.toFixed(3)};
const float CLOUDS = ${SKY.clouds.toFixed(3)};
const float DRIFT = ${SKY.drift.toFixed(5)};
const float SUN_SIZE = ${SKY.sunSize.toFixed(3)};
float rnd(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec3 d = normalize(vDir);
  float el = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.z, d.x);
  float up = clamp(d.y, 0.0, 1.0);

  // The air: pale by the horizon, deep overhead, a little warm round the sun.
  vec3 c = mix(vec3(0.42, 0.70, 0.95), vec3(0.10, 0.36, 0.86), smoothstep(0.0, 0.34, up));
  c = mix(c, vec3(0.025, 0.15, 0.70), smoothstep(0.25, 0.95, up));
  float toSun = dot(d, uSun);
  c += vec3(0.10, 0.08, 0.02) * pow(clamp(toSun, 0.0, 1.0), 8.0) * (1.0 - uFlat);
  // Below the horizon, where the land has run out: far country in haze.
  c = mix(c, vec3(0.40, 0.66, 0.66), 1.0 - smoothstep(-0.09, -0.01, d.y));
  c = mix(c, vec3(0.26, 0.52, 0.34), 1.0 - smoothstep(-0.5, -0.09, d.y));
  // The flat look: one blue from the horizon up.
  c = mix(c, vec3(0.09, 0.40, 1.0), uFlat * smoothstep(-0.02, 0.0, d.y));
  c *= BRIGHT;

  // The sun: a warm disc with a drawn edge and a pale ring of glow.
  float sunAngle = acos(clamp(toSun, -1.0, 1.0));
  float aa = 0.0014;
  float glow = exp(-sunAngle * 9.0);
  c = mix(c, vec3(1.0, 0.92, 0.60) * CLOUD_BRIGHT, glow * 0.35 * (1.0 - uFlat));
  float rim = 1.0 - smoothstep(SUN_SIZE + 0.006 - aa, SUN_SIZE + 0.006 + aa, sunAngle);
  float disc = 1.0 - smoothstep(SUN_SIZE - aa, SUN_SIZE + aa, sunAngle);
  c = mix(c, vec3(1.0, 0.42, 0.04) * CLOUD_BRIGHT, rim);
  c = mix(c, vec3(1.0, 0.80, 0.22) * CLOUD_BRIGHT * 1.3, disc);

  // Clouds, laid out like a painted backdrop in three rows: small and far near the horizon, big higher up.
  // Each row is a ring of places round the sky; a place holds a cloud or not, and a cloud is five puffs
  // side by side, cut flat along the bottom.
  for (int row = 0; row < 3; row++) {
    float rowEl = row == 0 ? 0.11 : row == 1 ? 0.27 : 0.50;
    float puff = row == 0 ? 0.040 : row == 1 ? 0.064 : 0.098;
    float places = row == 0 ? 15.0 : row == 1 ? 10.0 : 7.0;
    float around = cos(rowEl);
    float placeWidth = 6.2831853 / places;
    float a = az + uTime * DRIFT * (0.6 + 0.5 * float(row)) + float(row) * 1.7;
    float place = floor(a / placeWidth);
    for (int k = -1; k <= 1; k++) {
      float id = place + float(k);
      float own = id - places * floor(id / places) + float(row) * 31.0;
      float r1 = rnd(own * 127.1 + 3.7);
      float r2 = rnd(own * 269.5 + 1.3);
      float r3 = rnd(own * 419.2 + 7.1);
      if (r1 > CLOUDS) continue;
      float s = puff * (0.75 + 0.6 * r2);
      float middle = (id + 0.5 + (r3 - 0.5) * 0.45) * placeWidth;
      vec2 p = vec2((a - middle) * around, el - (rowEl + (r2 - 0.5) * 0.07)) / s;
      if (abs(p.x) > 3.2 || p.y > 2.6 || p.y < -0.3) continue;
      float shape = 1000.0;
      for (int j = 0; j < 5; j++) {
        float fj = float(j);
        float rj = rnd((own * 17.0 + fj * 53.0) * 12.9898);
        float big = (1.0 - abs(fj - 2.0) * 0.21) * (0.72 + 0.42 * rj);
        vec2 at = vec2((fj - 2.0) * 0.64 + (rj - 0.5) * 0.2, big * 0.52);
        shape = min(shape, length(p - at) - big);
      }
      // Sunlit above, shaded in a wavy band along the flat bottom.
      float underside = 0.34 + 0.09 * sin(p.x * 4.3 + own * 2.1) + 0.05 * sin(p.x * 9.1 + own);
      float edge = max(shape, -p.y);
      float soft = aa / s;
      float inside = 1.0 - smoothstep(-soft, soft, edge);
      float lineWidth = uCloudInk * 0.0032 / s;
      float inked = smoothstep(-lineWidth - soft, -lineWidth + soft, edge);
      float shaded = (1.0 - smoothstep(underside - 0.03, underside + 0.03, p.y)) * (1.0 - 0.75 * uFlat);
      vec3 cloud = mix(vec3(1.0, 1.0, 0.985), vec3(0.56, 0.69, 0.93), shaded) * CLOUD_BRIGHT;
      cloud = mix(cloud, mix(vec3(0.05, 0.13, 0.38), vec3(0.01, 0.012, 0.02), uFlat), inked * step(0.001, uCloudInk));
      // Far clouds sink into the air by the horizon.
      cloud = mix(cloud, c, (row == 0 ? 0.30 : row == 1 ? 0.10 : 0.0) * (1.0 - uFlat));
      c = mix(c, cloud, inside);
    }
  }
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}
`;

export class Sky {
  /** @param {THREE.Scene} scene  @param {THREE.Vector3} sun  where the sun stands, as a direction from the world to it */
  constructor(scene, sun) {
    this.uniforms = { uSun: { value: sun.clone().normalize() }, uTime: { value: 0 }, uFlat: flat, uCloudInk: { value: SKY.cloudInk } };
    this.ball = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
      uniforms: this.uniforms, side: THREE.BackSide, depthTest: false, depthWrite: false, fog: false,
      vertexShader: "varying vec3 vDir;\nvoid main() {\n  vDir = position;\n  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);\n}",
      fragmentShader: SKY_SHADER,
    }));
    this.ball.scale.setScalar(3000);
    this.ball.renderOrder = -100; // behind everything
    this.ball.frustumCulled = false;
    this.ball.layers.set(LAYER.sky);
    scene.add(this.ball);
    const tune = () => { this.uniforms.uCloudInk.value = look.name === "flat" ? FLAT.cloudInk : SKY.cloudInk; };
    onLook(tune);
    tune();
  }

  /** Every frame: the ball stays round the camera, and the clouds drift. `t` is the shared clock in seconds. */
  frame(camera, t) {
    this.ball.position.copy(camera.position);
    this.uniforms.uTime.value = t % 100000;
  }
}

// ---------------------------------------------------------------- the black line
const INK_SHADER = `
uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uHeight;
uniform float uNear;
uniform float uFar;
varying vec2 vUv;
const float INK_WIDTH = ${FLAT.inkWidth.toFixed(3)};
const float INK_STRENGTH = ${FLAT.inkStrength.toFixed(3)};
const float INK_FAR = ${FLAT.inkFar.toFixed(3)};
const float FAR_WIDTH = ${FLAT.farWidth.toFixed(3)};
const float DEPTH_EDGE = ${FLAT.depthEdge.toFixed(4)};
const float PAINT_EDGE = ${FLAT.paintEdge.toFixed(4)};
const float PAINT_INK = ${FLAT.paintInk.toFixed(3)};
const float FADE_START = ${FLAT.fadeStart.toFixed(1)};
const float FADE_END = ${FLAT.fadeEnd.toFixed(1)};
// One over the distance in front of the camera, from what the depth buffer holds. Across any flat surface,
// however steeply it is seen, this changes evenly from pixel to pixel: so where it bends, one thing ends
// and another begins, and the ground does not grow lines near the horizon.
float oneOver(float d) { return (uFar - d * (uFar - uNear)) / (uNear * uFar); }
void main() {
  vec4 here = texture2D(tColor, vUv);
  vec3 c = here.rgb;
  float d = texture2D(tDepth, vUv).x;
  float inv = oneOver(d);
  float depth = 1.0 / inv;
  float haze = clamp((depth - FADE_START) / (FADE_END - FADE_START), 0.0, 1.0);
  // The line thins with distance: a far hillside of trees would otherwise be solid black.
  float w = max(1.0, INK_WIDTH * uHeight / 720.0 * mix(1.0, FAR_WIDTH, haze));
  // No line for a change of colour in the sky, which has its own drawn lines, or on a sign's letters (see unlined).
  float solid = step(d, 0.9999995) * step(0.5, here.a);
  float nearest = depth;
  float edge = 0.0;
  for (int axis = 0; axis < 2; axis++) {
    vec2 o = (axis == 0 ? vec2(w, 0.0) : vec2(0.0, w)) * uTexel;
    float i1 = oneOver(texture2D(tDepth, vUv + o).x);
    float i2 = oneOver(texture2D(tDepth, vUv - o).x);
    nearest = min(nearest, min(1.0 / i1, 1.0 / i2));
    float bend = abs((i1 + i2) * 0.5 / inv - 1.0);
    edge = max(edge, smoothstep(DEPTH_EDGE, DEPTH_EDGE * 2.5, bend));
    vec3 c1 = texture2D(tColor, vUv + o).rgb;
    vec3 c2 = texture2D(tColor, vUv - o).rgb;
    float paintStep = max(length(c1 - c), length(c2 - c));
    edge = max(edge, PAINT_INK * smoothstep(PAINT_EDGE, PAINT_EDGE * 1.6, paintStep) * solid);
  }
  float nearFar = clamp((nearest - FADE_START) / (FADE_END - FADE_START), 0.0, 1.0);
  float ink = clamp(edge * INK_STRENGTH * mix(1.0, INK_FAR, nearFar), 0.0, 1.0);
  gl_FragColor = vec4(mix(c, vec3(0.0), ink), 1.0);
  #include <colorspace_fragment>
}
`;

export class Ink {
  /** @param {THREE.WebGLRenderer} renderer */
  constructor(renderer) {
    this.renderer = renderer;
    this.target = null; // made the first time the line is wanted
    this.uniforms = { tColor: { value: null }, tDepth: { value: null }, uTexel: { value: new THREE.Vector2() }, uHeight: { value: 720 }, uNear: { value: 0.2 }, uFar: { value: 6000 } };
    this.flat = new THREE.Scene();
    const square = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
      uniforms: this.uniforms, depthTest: false, depthWrite: false,
      vertexShader: "varying vec2 vUv;\nvoid main() {\n  vUv = uv;\n  gl_Position = vec4(position.xy, 0.0, 1.0);\n}",
      fragmentShader: INK_SHADER,
    }));
    square.frustumCulled = false;
    this.flat.add(square);
    this.facing = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.size = new THREE.Vector2();
  }

  /** The picture the world is drawn into, at the size of the screen. */
  fit() {
    const { renderer } = this;
    renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x), h = Math.max(1, this.size.y);
    if (!this.target) {
      // Colours as amounts of light with room to spare, where the graphics card can; plain bytes where it cannot.
      const fine = renderer.extensions.has("EXT_color_buffer_float") || renderer.extensions.has("EXT_color_buffer_half_float");
      this.target = new THREE.WebGLRenderTarget(w, h, { type: fine ? THREE.HalfFloatType : THREE.UnsignedByteType, samples: 4, depthTexture: new THREE.DepthTexture(w, h) });
      this.uniforms.tColor.value = this.target.texture;
      this.uniforms.tDepth.value = this.target.depthTexture;
    } else if (this.target.width !== w || this.target.height !== h) this.target.setSize(w, h);
    this.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.uniforms.uHeight.value = h;
  }

  /** Draws the world with its black line; then the names and speech bubbles over it, which get none. */
  render(scene, camera) {
    const { renderer } = this;
    this.fit();
    this.uniforms.uNear.value = camera.near;
    this.uniforms.uFar.value = camera.far;
    const all = camera.layers.mask;
    camera.layers.set(LAYER.world);
    camera.layers.enable(LAYER.sky);
    renderer.setRenderTarget(this.target);
    marking.value = 1;
    renderer.render(scene, camera);
    marking.value = 0;
    renderer.setRenderTarget(null);
    renderer.render(this.flat, this.facing);
    const clear = renderer.autoClear;
    renderer.autoClear = false;
    camera.layers.set(LAYER.over);
    renderer.render(scene, camera);
    renderer.autoClear = clear;
    camera.layers.mask = all;
  }

  /** The look has no line just now: the picture's memory is given back. */
  rest() {
    this.target?.dispose();
    this.target?.depthTexture?.dispose();
    this.target = null;
  }
}
