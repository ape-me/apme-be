import type { Env } from "../env";
import { resend } from "../lib/resend";

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DISPOSABLE = ["mailinator.com", "guerrillamail.com", "10minutemail.com", "tempmail.com", "yopmail.com", "sharklasers.com", "guerrillamailblock.com", "temp-mail.org"];

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  const domain = e.slice(e.indexOf("@") + 1);
  if (!domain.includes(".") || DISPOSABLE.some((d) => domain === d || domain.endsWith("." + d))) return null;
  return e;
}

const b64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const newToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// sha256(ip + daily salt): lets us spot abuse within a day without ever storing an IP.
export async function ipHash(ip: string, salt: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${day}|${salt}`));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const apelist = {
  /** Insert if new. Returns true when the row was created, false when the email already existed. */
  add: async (env: Env, email: string, token: string, ip_hash: string, ref: string | null, ua: string | null): Promise<boolean> => {
    const r = await env.DB.prepare(
      "INSERT INTO apelist (email, confirm_token, ip_hash, ref, user_agent) VALUES (?1, ?2, ?3, ?4, ?5) ON CONFLICT(email) DO NOTHING",
    ).bind(email, token, ip_hash, ref, ua).run();
    return (r.meta.changes ?? 0) > 0;
  },

  count: async (env: Env): Promise<number> => {
    const r = await env.DB.prepare("SELECT count(*) AS n FROM apelist").first<{ n: number }>();
    return r?.n ?? 0;
  },

  /** Marks the row confirmed. Returns false for an unknown token. Re-clicking a used link is fine. */
  confirm: async (env: Env, token: string): Promise<boolean> => {
    if (!/^[A-Za-z0-9_-]{40,50}$/.test(token)) return false;
    const r = await env.DB.prepare(
      "UPDATE apelist SET confirmed_at = COALESCE(confirmed_at, strftime('%Y-%m-%dT%H:%M:%fZ','now')) WHERE confirm_token = ?1",
    ).bind(token).run();
    return (r.meta.changes ?? 0) > 0;
  },

  sendConfirmation: async (env: Env, email: string, token: string): Promise<void> => {
    if (!env.RESEND_API_KEY) { console.warn("apelist: RESEND_API_KEY unset, skipping email"); return; }
    const link = `${env.PUBLIC_URL}/api/apelist/confirm?t=${token}`;
    const text = `ape memes. ape stonks.\n\ntap to confirm your spot: ${link}\n\nwe'll email you once when ApeMe hits the App Store. that's it.`;
    const html = `<p>ape memes. ape stonks.</p><p><a href="${link}">tap to confirm your spot</a></p><p>we'll email you once when ApeMe hits the App Store. that's it.</p>`;
    try {
      await resend.send(env.RESEND_API_KEY, { from: "ApeMe <hey@apeme.fun>", to: email, subject: "you're on the apelist", text, html });
    } catch (e) {
      console.error("apelist: confirmation email failed", (e as Error).message);
    }
  },
};
