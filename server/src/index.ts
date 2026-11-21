import path from "node:path";
import { createApp } from "./app.ts";
import { CACHE_DIR } from "./cache.ts";
import { FileJournalStore } from "./journal.ts";
import { AccountDirectory } from "./people.ts";

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
});
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
