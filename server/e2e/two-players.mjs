// End-to-end check of the browser client: two players join the same room, see each other, chat
// and travel to one another. Starts its own server (with an access code) on a spare port.
//
//   npm run e2e            needs Playwright available to Node (npm i -g playwright, or as a dev dependency)
//   SHOTS=dir npm run e2e  also saves screenshots into dir

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { chromium } = createRequire(import.meta.url)("playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8799;
const BASE = `http://localhost:${PORT}`;
const CODE = "otter-42";
const shots = process.env.SHOTS;

const server = spawn(process.execPath, ["src/index.ts"], { cwd: root, env: { ...process.env, PORT: String(PORT), EARTHWALK_ACCESS_CODE: CODE }, stdio: ["ignore", "inherit", "inherit"] });
const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });

async function join(name, animal, code) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: shots ? 2 : 1 });
  const page = await context.newPage();
  page.on("pageerror", (e) => { throw e; });
  await page.goto(`${BASE}/?room=e2e&code=${encodeURIComponent(code)}`);
  await page.fill("#name", name);
  await page.check(`#animals input[value="${animal}"]`, { force: true });
  await page.click("#go");
  return page;
}
const landed = (page) => page.waitForFunction(() => window.earthwalk.isStarted() && !window.earthwalk.player.waitingForGround, null, { timeout: 180000 });
const logText = (page) => page.textContent("#log");

try {
  for (let i = 0; ; i++) {
    try { if ((await fetch(`${BASE}/health`)).ok) break; } catch { /* not up yet */ }
    if (i > 50) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }

  // A wrong code is refused with a clear message, and the world stays closed.
  const stranger = await join("Stranger", "frog", "wrong");
  await stranger.waitForFunction(() => document.getElementById("join-error").textContent.includes("access code"));
  assert.equal(await stranger.evaluate(() => window.earthwalk.isStarted()), false);
  if (shots) await stranger.screenshot({ path: path.join(shots, "join.png") });
  await stranger.context().close();

  const mum = await join("Mum", "owl", CODE);
  await landed(mum);
  const kid = await join("Kid", "fox", CODE);
  await landed(kid);

  // Each sees the other as the animal they chose.
  await kid.waitForFunction(() => window.earthwalk.avatars.shown.size === 1);
  await mum.waitForFunction(() => window.earthwalk.avatars.shown.size === 1);
  assert.equal(await kid.evaluate(() => [...window.earthwalk.avatars.shown.values()][0].avatar), "owl");
  assert.equal(await mum.evaluate(() => [...window.earthwalk.avatars.shown.values()][0].avatar), "fox");

  // Mum walks; Kid sees her avatar move by the same amount.
  const seen = () => kid.evaluate(() => { const p = [...window.earthwalk.avatars.shown.values()][0].group.position; return [p.x, p.z]; });
  const own = () => mum.evaluate(() => { const p = window.earthwalk.player.position; return [p.x, p.z]; });
  const [seenBefore, ownBefore] = [await seen(), await own()];
  await mum.keyboard.down("KeyW");
  await mum.waitForTimeout(2000);
  await mum.keyboard.up("KeyW");
  await mum.waitForTimeout(300);
  const ownAfter = await own();
  await kid.waitForTimeout(1200);
  const seenAfter = await seen();
  const walked = Math.hypot(ownAfter[0] - ownBefore[0], ownAfter[1] - ownBefore[1]);
  const watched = Math.hypot(seenAfter[0] - seenBefore[0], seenAfter[1] - seenBefore[1]);
  assert.ok(walked > 1, `Mum walked ${walked.toFixed(1)} m`);
  assert.ok(Math.abs(walked - watched) < 0.5, `Mum walked ${walked.toFixed(1)} m but Kid saw ${watched.toFixed(1)} m`);

  // Chat reaches the other player.
  await mum.keyboard.press("Enter");
  await mum.keyboard.type("hello from mum");
  await mum.keyboard.press("Enter");
  await kid.waitForFunction(() => document.getElementById("log").textContent.includes("Mum: hello from mum"));

  // Kid travels somewhere else, then back to Mum with /join.
  await kid.evaluate(() => window.earthwalk.command("goto", "48.87, 2.31"));
  await kid.waitForFunction(() => window.earthwalk.player.waitingForGround === true);
  await landed(kid);
  await kid.evaluate(() => window.earthwalk.command("join", "mu"));
  await landed(kid);
  const gap = await Promise.all([mum, kid].map((p) => p.evaluate(() => window.earthwalk.world.sceneToGeo(window.earthwalk.player.position))));
  const metres = Math.hypot((gap[0].lat - gap[1].lat) * 111320, (gap[0].lon - gap[1].lon) * 111320 * Math.cos((gap[0].lat * Math.PI) / 180));
  assert.ok(metres < 10, `after /join the players are ${metres.toFixed(1)} m apart`);
  assert.ok((await logText(kid)).includes("Travelling to Mum"));

  if (shots) {
    await kid.evaluate(() => { window.earthwalk.player.yaw = Math.PI; window.earthwalk.player.pitch = -0.1; }); // Mum is just to the south
    await kid.waitForTimeout(1500);
    await kid.screenshot({ path: path.join(shots, "meetup.png") });
  }
  console.log("e2e ok: two players met, saw each other move, chatted and travelled to one another");
} finally {
  await browser.close();
  server.kill();
}
