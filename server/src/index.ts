import path from "node:path";
import { createApp } from "./app.ts";
import { CACHE_DIR } from "./cache.ts";
import { FileJournalStore } from "./journal.ts";
import { AccountDirectory } from "./people.ts";
import { FORMAT_VERSION, GENERATOR_REV } from "./chunk.ts";
import { LABELS_REV } from "./labels.ts";
import { INTERIOR_REV } from "./interior.ts";
import { keepRoom, removeRetired } from "./prune.ts";
import { BLOCK_Z, keepExtrasComing, onExtras, RETIRED_CACHE, warmOsmTile } from "./osm.ts";
import { keepShowsBuilt } from "./showcase.ts";
import { CHUNK_Z } from "./geo.ts";

// One thing going wrong for one player must never stop the world for everyone. Left alone, Node ends the
// process when a promise fails with nobody waiting on it, or an error escapes a timer; here it is written down
// (where the host's log shows it) and the server carries on.
process.on("unhandledRejection", (err) => console.error("carrying on after a failure nobody caught:", err));
process.on("uncaughtException", (err) => console.error("carrying on after an error nobody caught:", err));

const PORT = Number(process.env.PORT ?? 8787);
const accessCode = process.env.EARTHWALK_ACCESS_CODE ?? "";
const clientId = process.env.EARTHWALK_GOOGLE_CLIENT_ID ?? "";
const clientSecret = process.env.EARTHWALK_GOOGLE_CLIENT_SECRET ?? "";
const invited = (process.env.EARTHWALK_INVITED ?? "").split(/[,\s]+/).filter(Boolean);

// People and their tokens live beside the world cache, which hosts mount as a persistent disk.
const accounts = await AccountDirectory.open(path.join(CACHE_DIR, "people", "people.json"), { accessCode, invited });

const app = createApp({
  accessCode,
  trustProxy: process.env.EARTHWALK_TRUST_PROXY === "1",
  accounts,
  // Journals live beside the accounts, one pair of files a person.
  journalStore: new FileJournalStore(path.join(CACHE_DIR, "journal")),
  google: clientId && clientSecret ? { clientId, clientSecret } : undefined,
  baseUrl: process.env.EARTHWALK_BASE_URL,
  // The map ahead of anyone travelling is downloaded before they get there (ahead.ts).
  warm: (dx, dy) => void warmOsmTile(dx, dy),
});
// The cache only ever grew, and a full disk once stopped the server: old versions' leftovers go at start-up, and
// room is kept free from then on (prune.ts). Accounts and journals are never touched.
keepRoom(CACHE_DIR, [
  `chunks/v${FORMAT_VERSION}.${GENERATOR_REV}`, `labels/v1.${LABELS_REV}`, `interiors/v${FORMAT_VERSION}.${GENERATOR_REV}.${INTERIOR_REV}`,
]);

// What an older way of downloading the map left behind is of no use now.
void removeRetired(CACHE_DIR, RETIRED_CACHE).then((gone) => { if (gone.length) console.log(`cache: removed what is no longer read (${gone.join(", ")})`); });
// Where something was built before the 3D pieces of its buildings came, it is built again once they have.
onExtras((bx, by) => {
  const per = 2 ** (CHUNK_Z - BLOCK_Z);
  for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) void app.forget(bx * per + i, by * per + j);
  console.log(`map: the 3D pieces for block ${bx}/${by} have come; what was built there will be built again`);
});
keepExtrasComing();
// The places in "Show me..." are kept built, so that showing the world to somebody starts at once.
if (process.env.EARTHWALK_SHOWCASE !== "0") keepShowsBuilt(app.prepare, warmOsmTile);

// A restart (every deploy is one) must not lose the last half minute of anyone's journal.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    void app.journals.close().finally(() => process.exit(0));
  });
}

app.server.listen(PORT, () => {
  console.log(`EarthWalk world server on http://localhost:${PORT}`);
  console.log(accessCode ? "An access code is required to join." : "No access code set: anyone who can reach this address can join.");
  console.log(clientId && clientSecret ? `Google sign-in is on (${accounts.list().length} people known).` : "Google sign-in is off (set EARTHWALK_GOOGLE_CLIENT_ID and _SECRET to turn it on).");
});
