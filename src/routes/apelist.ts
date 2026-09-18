// Email waitlist. Every response is JSON; the frontend is coded against these exact shapes.
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "../env";
import { verifyTurnstile } from "../lib/turnstile";
import { apelist, normalizeEmail, newToken, ipHash } from "../services/apelist";

export const apelistRoute = new Hono<{ Bindings: Env }>();

apelistRoute.use("*", async (c, next) => {
  const allowed = (c.env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return cors({ origin: (o) => (allowed.includes(o) ? o : ""), allowMethods: ["POST", "GET", "OPTIONS"], allowHeaders: ["Content-Type"], maxAge: 86400 })(c, next);
});

const fail = (c: { json: (b: unknown, s?: number) => Response }, status: 400 | 429 | 500, error: string) => c.json({ ok: false, error }, status);

apelistRoute.post("/", async (c) => {
  const ip = c.req.header("cf-connecting-ip") ?? "0.0.0.0";
  if (c.env.RL_APELIST) {
    const { success } = await c.env.RL_APELIST.limit({ key: ip });
    if (!success) return fail(c, 429, "rate_limited");
  }
  let body: { email?: unknown; turnstile?: unknown; ref?: unknown };
  try { body = await c.req.json(); } catch { return fail(c, 400, "invalid_email"); }

  const email = normalizeEmail(body.email);
  if (!email) return fail(c, 400, "invalid_email");
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET, typeof body.turnstile === "string" ? body.turnstile : "", ip))) return fail(c, 400, "bot");

  const ref = typeof body.ref === "string" && body.ref.trim() ? body.ref.trim().slice(0, 64) : null;
  const ua = (c.req.header("user-agent") ?? "").slice(0, 256) || null;
  try {
    const token = newToken();
    const created = await apelist.add(c.env, email, token, await ipHash(ip, c.env.IP_SALT ?? "apeme"), ref, ua);
    if (!created) return c.json({ ok: true }, 200);
    c.executionCtx.waitUntil(apelist.sendConfirmation(c.env, email, token));
    return c.json({ ok: true }, 201);
  } catch (e) {
    console.error("apelist insert", (e as Error).message);
    return fail(c, 500, "server");
  }
});

apelistRoute.get("/count", async (c) => {
  try {
    const count = await apelist.count(c.env);
    c.header("Cache-Control", "public, max-age=60");
    return c.json({ count });
  } catch (e) {
    console.error("apelist count", (e as Error).message);
    return fail(c, 500, "server");
  }
});

apelistRoute.get("/confirm", async (c) => {
  const t = c.req.query("t") ?? "";
  let ok = false;
  try { ok = await apelist.confirm(c.env, t); } catch (e) { console.error("apelist confirm", (e as Error).message); }
  return c.redirect(`${c.env.SITE_URL}/?confirmed=${ok ? 1 : 0}`, 302);
});
