import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { subtle } from "node:crypto";
import { Jwks, verifyIdToken } from "../src/google.ts";
import { AccountDirectory, GuestDirectory } from "../src/people.ts";
import { shortPlaceName } from "../src/geocode.ts";

const mum = { sub: "g-1", email: "Mum@example.com", name: "Mum" };
const kid = { sub: "g-2", email: "kid@example.com", name: "Kid" };

test("guests still work exactly as before", async () => {
  const open = new GuestDirectory();
  assert.deepEqual(await open.identify({ name: "Ann", room: "x" }), { personId: null, displayName: "Ann" });
  assert.equal((await open.identify({ name: "", room: "x" }))?.displayName, "Guest");
  const gated = new GuestDirectory("secret");
  assert.equal(await gated.identify({ name: "Ann", room: "x", token: "nope" }), null);
  assert.equal((await gated.identify({ name: "Ann", room: "x", token: "secret" }))?.displayName, "Ann");
});

test("accounts: sign-up gate, tokens, homes, and the guest fallback", async () => {
  const dir = new AccountDirectory(undefined, { accessCode: "secret", invited: ["kid@example.com"] });
  // Nobody is known yet: without the code or an invitation, Google accounts are refused.
  assert.equal(dir.signIn(mum), null);
  assert.equal(dir.signIn(mum, { accessCode: "wrong" }), null);
  const m = dir.signIn(mum, { accessCode: "secret" });
  assert.ok(m, "the access code lets a new account in");
  assert.equal(m.person.email, "mum@example.com", "emails are kept lowercase");
  assert.equal(m.person.name, "Mum");
  const k = dir.signIn(kid);
  assert.ok(k, "an invited email needs no code");
  // Once known, signing in again (even without the code) finds the same record and a new token.
  const again = dir.signIn(mum);
  assert.ok(again);
  assert.equal(again.person.id, m.person.id);
  assert.notEqual(again.token, m.token);
  assert.equal(dir.byToken(m.token)?.id, m.person.id, "old tokens stay valid");
  assert.equal(dir.byToken("made-up"), null);

  // Joining with a token identifies the account; the name and animal asked for become the account's.
  const who = await dir.identify({ name: "Mummy", room: "family", token: m.token, avatar: "owl" });
  assert.deepEqual(who, { personId: m.person.id, displayName: "Mummy", avatar: "owl", home: null });
  assert.equal(dir.get(m.person.id)?.avatar, "owl");
  assert.equal((await dir.identify({ name: "", room: "family", token: k.token }))?.displayName, "Kid", "no name given keeps the account's");
  // Guests with the access code still get in; strangers do not.
  assert.deepEqual(await dir.identify({ name: "Visitor", room: "family", token: "secret" }), { personId: null, displayName: "Visitor" });
  assert.equal(await dir.identify({ name: "Visitor", room: "family", token: "nope" }), null);
  assert.equal(await dir.identify({ name: "Visitor", room: "family" }), null);

  await dir.setHome(m.person.id, { lat: 48.8583, lon: 2.2945, name: "Tour Eiffel, 5 Avenue Anatole France, Paris 7e" });
  assert.equal((await dir.identify({ name: "", room: "x", token: m.token }))?.home?.name, "Tour Eiffel, 5 Avenue Anatole France, Paris 7e", "home names are not cut short like player names");
  assert.ok(dir.revokeToken(m.token));
  assert.equal(dir.byToken(m.token), null, "a revoked token no longer identifies anyone");
  assert.equal(await dir.identify({ name: "", room: "x", token: m.token }), null, "...and is not an access code either");
  assert.equal(dir.list().length, 2);
});

test("an open server (no access code) lets any Google account sign up", () => {
  const dir = new AccountDirectory();
  assert.ok(dir.signIn(mum));
});

test("the people file survives a restart", async () => {
  const tmp = await mkdtemp(path.join(tmpdir(), "earthwalk-people-"));
  try {
    const file = path.join(tmp, "nested", "people.json");
    const a = await AccountDirectory.open(file, { accessCode: "secret" });
    const m = a.signIn(mum, { accessCode: "secret" })!;
    await a.setHome(m.person.id, { lat: 1, lon: 2, name: "Home" });
    a.touch(m.person.id, { room: "family", place: "Paris, France", lat: 1.5, lon: 2.5 });
    await a.save();
    const raw = JSON.parse(await readFile(file, "utf8"));
    assert.equal(raw.people.length, 1);
    assert.ok(!JSON.stringify(raw).includes(m.token), "only the token's hash is stored");

    const b = await AccountDirectory.open(file, { accessCode: "secret" });
    const p = b.byToken(m.token);
    assert.ok(p, "tokens issued before the restart still work");
    assert.equal(p.email, "mum@example.com");
    assert.deepEqual(p.home, { lat: 1, lon: 2, name: "Home" });
    assert.equal(p.lastPlace, "Paris, France");
    assert.equal(p.lastRoom, "family");
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

/** A token signed with our own key stands in for Google's. */
async function signedToken(claims: Record<string, unknown>, opts: { kid?: string; alg?: string } = {}) {
  const pair = await subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = (await subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = `${b64({ alg: opts.alg ?? "RS256", kid: opts.kid ?? "k1" })}.${b64(claims)}`;
  const sig = Buffer.from(await subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, Buffer.from(head))).toString("base64url");
  const jwks = new Jwks(async () => new Response(JSON.stringify({ keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }] }), { headers: { "cache-control": "max-age=3600" } }));
  return { token: `${head}.${sig}`, jwks };
}

test("id tokens are verified against the published keys and their claims", async () => {
  const now = Math.floor(Date.now() / 1000);
  const good = { iss: "https://accounts.google.com", aud: "app-1", sub: "g-9", email: "x@example.com", email_verified: true, name: "X", exp: now + 600, nonce: "n1" };
  const t = await signedToken(good);
  assert.deepEqual(await verifyIdToken(t.token, "app-1", "n1", t.jwks), { sub: "g-9", email: "x@example.com", name: "X" });
  await assert.rejects(verifyIdToken(t.token, "other-app", "n1", t.jwks), /different app/);
  await assert.rejects(verifyIdToken(t.token, "app-1", "n2", t.jwks), /nonce/);
  const tampered = t.token.split(".");
  tampered[1] = Buffer.from(JSON.stringify({ ...good, sub: "g-10" })).toString("base64url");
  await assert.rejects(verifyIdToken(tampered.join("."), "app-1", "n1", t.jwks), /signature/);
  const expired = await signedToken({ ...good, exp: now - 600 });
  await assert.rejects(verifyIdToken(expired.token, "app-1", "n1", expired.jwks), /expired/);
  const unverified = await signedToken({ ...good, email_verified: false });
  await assert.rejects(verifyIdToken(unverified.token, "app-1", "n1", unverified.jwks), /not verified/);
  const unknownKey = await signedToken(good, { kid: "k2" });
  await assert.rejects(verifyIdToken(unknownKey.token, "app-1", "n1", unknownKey.jwks), /unknown key/);
  const wrongAlg = await signedToken(good, { alg: "none" });
  await assert.rejects(verifyIdToken(wrongAlg.token, "app-1", "n1", wrongAlg.jwks), /header/);
});

test("place names are short", () => {
  assert.equal(shortPlaceName({ suburb: "Montmartre", city: "Paris", country: "France" }), "Montmartre, Paris");
  assert.equal(shortPlaceName({ city: "Paris", country: "France" }), "Paris, France");
  assert.equal(shortPlaceName({ village: "Lacock", county: "Wiltshire", country: "United Kingdom" }), "Lacock, Wiltshire");
  assert.equal(shortPlaceName({}), null);
  assert.equal(shortPlaceName(undefined), null);
});
