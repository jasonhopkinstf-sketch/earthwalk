// The time of day: where the sun and the moon really stand over the place the player is in, and the
// light the world is drawn in because of it. The sums and the colours are skymath.js; this hands them to
// the lights, the haze and the sky (look.js).
//
// Two settings, kept on this device: "real" (the real sky over the place, by the clock) and "day" (the
// fine day the game always had, whatever the hour). And times of day to try out for one visit, which
// are moments of the real day over the place: "morning", "noon", "sunset", "night".

import { hour, night } from "./look.js";
import { FINE_DAY, moonAt, moonName, momentOf, skyDirection, skyLight, smooth, sunAt } from "./skymath.js";

const DEG = 180 / Math.PI;

export class DayNight {
  /**
   * @param {{ scene: import("three").Scene, renderer: import("three").WebGLRenderer, sun: import("three").DirectionalLight,
   *   hemi: import("three").HemisphereLight, sky: import("./look.js").Sky, setting?: string }} parts
   */
  constructor({ scene, renderer, sun, hemi, sky, setting }) {
    Object.assign(this, { scene, renderer, sun, hemi, sky });
    /** "real" or "day". */
    this.setting = setting === "day" ? "day" : "real";
    /** A time of day being tried out, or null. */
    this.trying = null;
    /** How far the pretended clock is from the real one, in milliseconds. */
    this.ahead = 0;
    /** What was last worked out, for the chat window and the tests: { sun, moon, light, at }. */
    this.now = null;
    /** A flash of lightning: how much brighter than usual, sinking back by itself (weather.js sets it). */
    this.flash = 0;
    this.place = null;
  }

  /** "real", "day", or a time of day to try out; false for anything else. */
  set(name, nowMs = Date.now()) {
    if (name === "real" || name === "day") {
      this.setting = name;
      this.trying = null;
      this.ahead = 0;
      return true;
    }
    if (!["morning", "noon", "sunset", "night"].includes(name) || !this.place) return false;
    this.trying = name;
    this.ahead = momentOf(name, nowMs, this.place.lat, this.place.lon) - nowMs;
    return true;
  }

  /** Is the sky the real one just now (and not the fine day, or a time being tried out)? */
  get real() {
    return this.setting === "real" && !this.trying;
  }

  /**
   * A few times a second: the sun and the moon over `place` ({ lat, lon }) at `nowMs`, and the light from them.
   * `air` is the weather's part: { veil, mist, clouds, fogNear, fogFar } (weatherdata.js).
   */
  tick(place, nowMs, air) {
    this.place = place;
    const fine = this.setting === "day" && !this.trying;
    const at = nowMs + this.ahead;
    const sun = fine ? FINE_DAY : sunAt(at, place.lat, place.lon);
    const moon = fine ? null : moonAt(at, place.lat, place.lon);
    const light = skyLight(sun, moon, air);
    this.now = { sun, moon, light, at };

    const cast = skyDirection(light.light.alt, light.light.az);
    this.sun.position.set(cast[0], cast[1], cast[2]);
    this.sun.color.setRGB(light.light.color[0], light.light.color[1], light.light.color[2]);
    this.sun.intensity = light.light.strength * (1 + this.flash * 0.5);
    this.hemi.color.setRGB(light.skyLight.color[0], light.skyLight.color[1], light.skyLight.color[2]);
    this.hemi.groundColor.setRGB(light.skyLight.ground[0], light.skyLight.ground[1], light.skyLight.ground[2]);
    this.hemi.intensity = light.skyLight.strength * (1 + this.flash);
    // Far land sinks into the haze the sky paints under its horizon; fog and rain bring it nearer.
    this.scene.fog.color.setRGB(light.haze[0], light.haze[1], light.haze[2]);
    this.scene.fog.near = air.fogNear;
    this.scene.fog.far = air.fogFar;
    this.renderer.setClearColor(this.scene.fog.color);
    hour.value.set(light.hour[0], light.hour[1], light.hour[2]);
    night.value = smooth(0.35, 0.75, light.night); // lamps in the windows as it gets dark
    this.sky.paint(light, skyDirection(sun.alt, sun.az), moon ? skyDirection(moon.alt, moon.az) : null, air.clouds);
    return light;
  }

  /** The sky in plain words, for the chat window. */
  said() {
    if (!this.now) return "";
    const { sun, moon } = this.now;
    if (!moon) return "It is always a fine day here. /time real follows the real sun and moon over wherever you are.";
    const points = ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"];
    const where = (az) => points[Math.round((az * DEG) / 45) % 8];
    const up = sun.alt * DEG;
    const sunSaid = up > 6 ? `the sun is ${Math.round(up)} degrees up in the ${where(sun.az)}` : up > -1 ? `the sun is on the horizon in the ${where(sun.az)}` : up > -8 ? "the sun has just gone under: twilight" : "it is night";
    const moonSaid = moon.alt > 0 ? `the moon is up in the ${where(moon.az)}: a ${moonName(moon.age)}` : `the moon (a ${moonName(moon.age)}) is under the horizon`;
    return `${this.trying ? `Trying out ${this.trying}` : "The real sky here"}: ${sunSaid}, and ${moonSaid}.`;
  }
}
