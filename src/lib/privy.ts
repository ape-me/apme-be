import type { Env } from "../env";
import { unauthorized } from "./errors";

// Privy identity tokens: ES256 JWTs signed with the app's key, iss=privy.io, aud=<app id>.
// Verified locally against the app's JWKS (public, cached), so no Privy call per request.

export type PrivyUser = { id: string; email: string | null; wallets: { address: string; chain: "solana" | "evm" }[] };

type Jwk = JsonWebKey & { kid: string };
let jwksCache: { at: number; keys: Jwk[] } | null = null;

async function jwks(appId: string): Promise<Jwk[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;
  const r = await fetch(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`, { cf: { cacheTtl: 3600, cacheEverything: true } } as RequestInit);
  if (!r.ok) throw new Error(`privy jwks ${r.status}`);
  const j = (await r.json()) as { keys: Jwk[] };
  jwksCache = { at: Date.now(), keys: j.keys };
  return j.keys;
}

const b64u = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(s.length + ((4 - (s.length % 4)) % 4), "=")), (c) => c.charCodeAt(0));
const dec = new TextDecoder();

export async function verifyIdToken(env: Env, token: string): Promise<PrivyUser> {
  if (!env.PRIVY_APP_ID) throw new Error("auth_not_configured");
  const parts = token.split(".");
  if (parts.length !== 3) throw unauthorized();
  const [h, body, sig] = parts as [string, string, string];
  const header = JSON.parse(dec.decode(b64u(h))) as { alg: string; kid?: string };
  if (header.alg !== "ES256") throw unauthorized();
  let keys = await jwks(env.PRIVY_APP_ID);
  let jwk = keys.find((k) => k.kid === header.kid) ?? keys[0];
  if (header.kid && !keys.some((k) => k.kid === header.kid)) { jwksCache = null; keys = await jwks(env.PRIVY_APP_ID); jwk = keys.find((k) => k.kid === header.kid) ?? keys[0]; }
  if (!jwk) throw unauthorized();
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, b64u(sig), new TextEncoder().encode(`${h}.${body}`));
  if (!ok) { console.warn("privy: bad signature", { kid: header.kid, keys: keys.map((k) => k.kid) }); throw unauthorized(); }
  const p = JSON.parse(dec.decode(b64u(body))) as { iss: string; aud: string | string[]; sub: string; exp: number; linked_accounts?: string };
  const aud = Array.isArray(p.aud) ? p.aud : [p.aud];
  if (p.iss !== "privy.io" || !aud.includes(env.PRIVY_APP_ID) || p.exp * 1000 < Date.now()) { console.warn("privy: claims", { iss: p.iss, aud, exp: p.exp }); throw unauthorized(); }
  const linked = p.linked_accounts ? (JSON.parse(p.linked_accounts) as { type: string; address?: string; chain_type?: string; wallet_client_type?: string }[]) : [];
  const wallets = linked
    .filter((a) => a.type === "wallet" && a.address && (a.chain_type === "solana" || a.chain_type === "ethereum"))
    .map((a) => ({ address: a.address!, chain: a.chain_type === "solana" ? ("solana" as const) : ("evm" as const) }));
  const email = linked.find((a) => a.type === "email")?.address ?? null;
  return { id: p.sub, email, wallets };
}
