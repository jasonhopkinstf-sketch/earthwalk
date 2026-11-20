// Sign in with Google: the OAuth 2.0 web flow and id-token verification, with nothing but
// `fetch` and WebCrypto. The flow is: send the browser to Google (`authUrl`), Google sends
// it back to our callback with a one-time code, we swap the code for tokens (`exchange`),
// and we check the id token's signature against Google's published keys (`verifyIdToken`).

import type { GoogleIdentity } from "./people.ts";

export interface GoogleOptions {
  clientId: string;
  clientSecret: string;
}

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export function authUrl(o: GoogleOptions, redirectUri: string, state: string, nonce: string): string {
  const u = new URL(AUTH_URL);
  u.searchParams.set("client_id", o.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("prompt", "select_account");
  return u.href;
}

interface Jwk { kid: string; kty: string; alg?: string; n: string; e: string; use?: string }
interface JwkSet { keys: Jwk[] }

/** Google's signing keys, cached for as long as the response allows (they rotate daily or so). */
class Jwks {
  private keys: Jwk[] = [];
  private until = 0;
  private readonly load: () => Promise<Response>;
  constructor(load: () => Promise<Response> = () => fetch(JWKS_URL, { signal: AbortSignal.timeout(15000) })) {
    this.load = load;
  }
  async get(kid: string): Promise<Jwk | null> {
    let key = Date.now() < this.until ? this.keys.find((k) => k.kid === kid) : undefined;
    if (!key) {
      const res = await this.load();
      if (!res.ok) throw new Error(`Google keys HTTP ${res.status}`);
      this.keys = ((await res.json()) as JwkSet).keys ?? [];
      const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") ?? "")?.[1];
      this.until = Date.now() + (maxAge ? Number(maxAge) * 1000 : 3600_000);
      key = this.keys.find((k) => k.kid === kid);
    }
    return key ?? null;
  }
}

const b64url = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64"));
const utf8 = (b: Uint8Array): string => Buffer.from(b).toString("utf8");

/**
 * Checks an id token's signature, issuer, audience, expiry and nonce, and returns who it is for.
 * `jwks` is replaceable so tests can sign tokens with their own key.
 */
export async function verifyIdToken(idToken: string, clientId: string, nonce: string, jwks: Jwks = sharedJwks): Promise<GoogleIdentity> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id token");
  const header = JSON.parse(utf8(b64url(parts[0]))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("unexpected id token header");
  const jwk = await jwks.get(header.kid);
  if (!jwk) throw new Error("id token signed with an unknown key");
  const key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) throw new Error("id token signature does not verify");
  const claims = JSON.parse(utf8(b64url(parts[1]))) as Record<string, unknown>;
  const now = Math.floor(Date.now() / 1000);
  if (!ISSUERS.has(String(claims.iss))) throw new Error("id token not issued by Google");
  if (claims.aud !== clientId) throw new Error("id token is for a different app");
  if (typeof claims.exp !== "number" || claims.exp < now - 60) throw new Error("id token has expired");
  if (claims.nonce !== nonce) throw new Error("id token nonce mismatch");
  if (typeof claims.sub !== "string" || !claims.sub) throw new Error("id token has no subject");
  if (claims.email_verified !== true || typeof claims.email !== "string") throw new Error("Google account email is not verified");
  return { sub: claims.sub, email: claims.email, name: typeof claims.name === "string" ? claims.name : claims.email.split("@")[0] };
}

const sharedJwks = new Jwks();
export { Jwks };

/** Swaps the one-time code from the callback for an id token, then verifies it. */
export function googleSignIn(o: GoogleOptions): (code: string, nonce: string, redirectUri: string) => Promise<GoogleIdentity> {
  return async (code, nonce, redirectUri) => {
    const body = new URLSearchParams({ code, client_id: o.clientId, client_secret: o.clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" });
    const res = await fetch(TOKEN_URL, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Google token exchange failed (HTTP ${res.status})`);
    const tokens = (await res.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("Google returned no id token");
    return verifyIdToken(tokens.id_token, o.clientId, nonce);
  };
}
