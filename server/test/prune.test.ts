import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { cacheWrite } from "../src/cache.ts";
import { AccountDirectory } from "../src/people.ts";
import { freeBytes, makeRoom, removeOldVersions } from "../src/prune.ts";

const exists = (file: string): Promise<boolean> => stat(file).then(() => true, () => false);
async function put(dir: string, rel: string, bytes: number, ageDays = 0): Promise<void> {
  const file = path.join(dir, rel);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, Buffer.alloc(bytes, 1));
  const when = new Date(Date.now() - ageDays * 86_400_000);
  await utimes(file, when, when);
}

test("what older versions built is cleared away at start-up; this version's, and everything that is somebody's, stays", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-prune-"));
  try {
    for (const rel of [
      "chunks/v1.8/16/1/2.ewc", "chunks/v1.9/16/1/2.ewc", "labels/v1.7/16/1/2.json", "labels/v1.9/16/1/2.json",
      "interiors/v1.9.1/16/1/2/3.ewc", "interiors/v1.9.2/16/1/2/3.ewc", "osm/15/1/2.json", "elevation/13/1/2.png",
      "journal/abc.json", "journal/abc.log", "people/people.json", "talk/spend.json",
    ]) await put(dir, rel, 100);
    const removed = await removeOldVersions(dir, ["chunks/v1.9", "labels/v1.9", "interiors/v1.9.2"]);
    assert.deepEqual(removed.sort(), ["chunks/v1.8", "interiors/v1.9.1", "labels/v1.7"]);
    for (const gone of ["chunks/v1.8", "labels/v1.7", "interiors/v1.9.1"]) assert.equal(await exists(path.join(dir, gone)), false, gone);
    for (const kept of ["chunks/v1.9/16/1/2.ewc", "labels/v1.9/16/1/2.json", "interiors/v1.9.2/16/1/2/3.ewc", "osm/15/1/2.json", "elevation/13/1/2.png", "journal/abc.json", "journal/abc.log", "people/people.json", "talk/spend.json"]) {
      assert.equal(await exists(path.join(dir, kept)), true, kept);
    }
    assert.deepEqual(await removeOldVersions(dir, ["chunks/v1.9", "labels/v1.9", "interiors/v1.9.2"]), [], "nothing more to do the second time");
    assert.deepEqual(await removeOldVersions(path.join(dir, "nowhere"), ["chunks/v1.9"]), [], "a cache that does not exist yet is no trouble");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("when the disk runs short, the oldest pieces of the cache go until there is room, and nothing that is somebody's", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-room-"));
  try {
    await put(dir, "osm/15/1/1.json", 4000, 30);
    await put(dir, "chunks/v1.9/16/1/1.ewc", 4000, 20);
    await put(dir, "osm/15/1/2.json", 4000, 10);
    await put(dir, "labels/v1.9/16/1/1.json", 4000, 5);
    await put(dir, "chunks/v1.9/16/1/2.ewc", 4000, 1);
    await put(dir, "journal/abc.json", 4000, 400);
    await put(dir, "people/people.json", 4000, 400);

    // Plenty of room, or a disk that will not say: nothing is touched.
    assert.equal(await makeRoom(dir, 1000, 2000, async () => 5000), 0);
    assert.equal(await makeRoom(dir, 1000, 2000, async () => null), 0);
    // 500 bytes free, 1000 wanted as a minimum, 9000 to get back to: the three oldest pieces make 12000.
    assert.equal(await makeRoom(dir, 1000, 9000, async () => 500), 3);
    assert.deepEqual([await exists(path.join(dir, "osm/15/1/1.json")), await exists(path.join(dir, "chunks/v1.9/16/1/1.ewc")), await exists(path.join(dir, "osm/15/1/2.json"))], [false, false, false]);
    assert.deepEqual([await exists(path.join(dir, "labels/v1.9/16/1/1.json")), await exists(path.join(dir, "chunks/v1.9/16/1/2.ewc"))], [true, true], "the newest stay");
    // However short of room, a journal and the accounts are never the answer.
    assert.equal(await makeRoom(dir, 1000, 10 ** 9, async () => 0), 2);
    assert.deepEqual((await readdir(path.join(dir, "journal"))).concat(await readdir(path.join(dir, "people"))), ["abc.json", "people.json"]);
    assert.equal(await makeRoom(dir, 1000, 10 ** 9, async () => 0), 0, "and with the cache empty there is nothing more to give");
    assert.equal(typeof (await freeBytes(dir)), "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a save that cannot be written does not stop anything: the cache is done without, and accounts carry on", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ew-full-"));
  const rejections: unknown[] = [];
  const note = (err: unknown): void => { rejections.push(err); };
  process.on("unhandledRejection", note);
  try {
    // A place nothing can be written: a path that runs through a plain file.
    await writeFile(path.join(dir, "blocker"), "x");
    const accounts = await AccountDirectory.open(path.join(dir, "blocker", "people", "people.json"));
    const ann = accounts.signIn({ sub: "g-1", email: "ann@example.com", name: "Ann" })!;
    assert.ok(ann.token);
    // Joining saves her last visit, without anyone waiting on the save: this is what used to stop the server.
    assert.equal((await accounts.identify({ token: ann.token, room: "family", name: "" }))?.displayName, "Ann");
    await accounts.save();
    // The cache is a convenience: a piece that cannot be kept is no error.
    await cacheWrite("bad\0name/piece.bin", "x");
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(rejections, [], "nothing failed without being caught");
  } finally {
    process.off("unhandledRejection", note);
    await rm(dir, { recursive: true, force: true });
  }
});
