// A thought bubble over every hungry animal nearby, with the food it would like in it. Which animals are
// hungry today follows from care.js, the same rule the server feeds them by; the journal says which of
// them I have fed already. Talking (T) to a hungry animal with that food in the lunch box feeds it.

import * as THREE from "three";
import { dayOf, hungerOf } from "./care.js";
import { MOUNTS } from "./riding.js";
import { unlinedSprite } from "./look.js";

const ICON = {
  apple: "🍎", carrot: "🥕", bread: "🍞", corn: "🌽", lettuce: "🥬", fish: "🐟", potato: "🥔", pumpkin: "🎃", nuts: "🌰", cheese: "🧀", egg: "🥚",
  milk: "🥛", berries: "🫐", tomato: "🍅", banana: "🍌", honey: "🍯", fig: "🍑",
};
const NAME = {
  apple: "an apple", carrot: "a carrot", bread: "a loaf of bread", corn: "a corn cob", lettuce: "a lettuce", fish: "a fish", potato: "a potato", pumpkin: "a pumpkin",
  nuts: "some nuts", cheese: "some cheese", egg: "an egg", milk: "some milk", berries: "some berries", tomato: "a tomato", banana: "a banana", honey: "some honey", fig: "a fig",
};
/** How far off a bubble is shown, how many at once, and how near an animal must be for the hint. */
const SEE_M = 45;
const MOST = 14;
const NEAR_M = 5;
/** Small animals have their bubble lower. */
const LOW = new Set(["duck", "goose", "swan", "chicken", "pigeon", "sparrow", "seagull", "heron", "rabbit", "squirrel", "mouse", "hedgehog", "cat", "dog", "fox", "tortoise", "penguin", "seal", "otter", "beaver", "marmot", "monkey", "capybara"]);

const pictures = new Map();
/** A white thought bubble with a food in it, painted once for each food. */
function picture(food) {
  let material = pictures.get(food);
  if (material) return material;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 96;
  const pen = canvas.getContext("2d");
  pen.fillStyle = "#ffffff";
  pen.strokeStyle = "#26221f";
  pen.lineWidth = 4;
  pen.beginPath();
  pen.arc(48, 40, 34, 0, Math.PI * 2);
  pen.fill();
  pen.stroke();
  for (const [x, y, r] of [[30, 80, 7], [20, 91, 4]]) { pen.beginPath(); pen.arc(x, y, r, 0, Math.PI * 2); pen.fill(); pen.stroke(); }
  pen.font = "40px system-ui, sans-serif";
  pen.textAlign = "center";
  pen.textBaseline = "middle";
  pen.fillText(ICON[food] ?? "🍽", 48, 43);
  const map = new THREE.CanvasTexture(canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  material = unlinedSprite(new THREE.SpriteMaterial({ map, depthWrite: false })); // it has its own drawn outline
  pictures.set(food, material);
  return material;
}

export class CareBubbles {
  /**
   * @param {{ scene: THREE.Scene, world: import("./world.js").World, player: import("./player.js").Player,
   *   meetup: import("./net.js").Meetup, life: import("./life.js").Life, hint: (text: string) => void }} parts
   */
  constructor(parts) {
    Object.assign(this, parts);
    this.sprites = [];
    this.fed = new Set(); // "horse:918398760": fed by me today
    this.near = null; // the hungry animal beside me: { thing, sp, want }
    const { meetup } = this;
    meetup.addEventListener("journal", (e) => { this.fed = new Set(e.detail?.care?.today ?? []); });
    meetup.addEventListener("stamp", (e) => { if (e.detail?.kind === "care") meetup.requestJournal(); });
  }

  /** Every frame, after the animals have been placed. `t` is the shared clock in seconds. */
  frame(t) {
    const { world, player: p, life } = this;
    const day = dayOf(t * 1000, -new Date().getTimezoneOffset());
    let n = 0;
    let near = null;
    let nearD = NEAR_M;
    for (const c of life.nearby) {
      const want = hungerOf(c.sp, c.thing, day);
      if (!want || this.fed.has(`${c.sp}:${c.thing}`)) continue;
      const d = Math.hypot(c.x - p.position.x, c.z - p.position.z);
      if (d > SEE_M) continue;
      if (d < nearD) { nearD = d; near = { thing: c.thing, sp: c.sp, want }; }
      if (n >= MOST) continue;
      const y = world.groundHeight(c.x, c.z);
      if (y === null) continue;
      let sprite = this.sprites[n];
      if (!sprite) {
        sprite = this.sprites[n] = new THREE.Sprite(picture(want));
        this.scene.add(sprite);
      }
      sprite.material = picture(want);
      const up = LOW.has(c.sp) ? 1.15 : (MOUNTS[c.sp]?.seat ?? 1.2) + 1.1;
      const size = 0.75 + Math.min(1.2, d / 30); // a little bigger far off, so that it can be made out
      sprite.scale.set(size, size, 1);
      sprite.position.set(c.x + 0.25, y + up + Math.sin(t * 2 + c.thing % 7) * 0.05, c.z);
      sprite.visible = true;
      n++;
    }
    for (let i = n; i < this.sprites.length; i++) this.sprites[i].visible = false;
    this.near = near;
    this.hint(near ? `It is hungry for ${NAME[near.want] ?? "something"}: T to talk` : "");
  }
}
