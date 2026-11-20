import { createApp } from "./app.ts";

const PORT = Number(process.env.PORT ?? 8787);
const accessCode = process.env.EARTHWALK_ACCESS_CODE ?? "";

const app = createApp({ accessCode, trustProxy: process.env.EARTHWALK_TRUST_PROXY === "1" });
app.server.listen(PORT, () => {
  console.log(`EarthWalk world server on http://localhost:${PORT}`);
  console.log(accessCode ? "An access code is required to join." : "No access code set: anyone who can reach this address can join.");
});
