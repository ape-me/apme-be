import type { Env } from "../env";
import { resend } from "../lib/resend";

const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/;
const DISPOSABLE = [
  "mailinator.com",
  "guerrillamail.com",
  "10minutemail.com",
  "tempmail.com",
  "yopmail.com",
  "sharklasers.com",
  "guerrillamailblock.com",
  "temp-mail.org",
];

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const e = raw.trim().toLowerCase();
  if (e.length > 254 || !EMAIL_RE.test(e)) return null;
  const domain = e.slice(e.indexOf("@") + 1);
  if (!domain.includes(".") || DISPOSABLE.some((d) => domain === d || domain.endsWith("." + d))) return null;
  return e;
}


// sha256(ip + daily salt): lets us spot abuse within a day without ever storing an IP.
export async function ipHash(ip: string, salt: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${day}|${salt}`));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export const apelist = {
  /** Insert if new. Returns true when the row was created, false when the email already existed. */
  add: async (env: Env, email: string, ip_hash: string, ref: string | null, ua: string | null): Promise<boolean> => {
    const r = await env.DB.prepare(
      "INSERT INTO apelist (email, ip_hash, ref, user_agent) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(email) DO NOTHING",
    )
      .bind(email, ip_hash, ref, ua)
      .run();
    return (r.meta.changes ?? 0) > 0;
  },

  count: async (env: Env): Promise<number> => {
    const r = await env.DB.prepare("SELECT count(*) AS n FROM apelist").first<{ n: number }>();
    return r?.n ?? 0;
  },

  sendWelcome: async (env: Env, email: string): Promise<void> => {
    if (!env.RESEND_API_KEY) {
      console.warn("apelist: RESEND_API_KEY unset, skipping email");
      return;
    }
    const text = `tokenized stocks, from your phone.\n\nyou're on the list. we'll email you once Stonks247 hits the App Store. that's it.`;
    const html = `<p>tokenized stocks, from your phone.</p><p>you're on the list. we'll email you once Stonks247 hits the App Store. that's it.</p>`;
    try {
      await resend.send(env.RESEND_API_KEY, {
        from: "Stonks247 <hey@apeme.fun>",
        to: email,
        subject: "you're on the list",
        text,
        html,
      });
    } catch (e) {
      console.error("apelist: welcome email failed", (e as Error).message);
    }
  },
};
