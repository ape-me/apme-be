import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { HttpError } from "./lib/errors";
import { withDb, type DbVars } from "./lib/db";
import { marketRepo } from "./repos/market";
import { read } from "./routes/read";
import { ingest } from "./routes/ingest";
import { ws } from "./routes/ws";

export { Room } from "./do/room";

const app = new Hono<{ Bindings: Env; Variables: DbVars }>();

app.use("*", cors({ origin: "*", allowMethods: ["GET", "POST"], maxAge: 86400 }));
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/health", withDb, async (c) => {
  const now = Math.floor(Date.now() / 1000);
  try {
    const t0 = Date.now();
    const h = await marketRepo.health(c.get("sql"));
    const dbMs = Date.now() - t0;
    const lag = h.newest_trade ? now - Number(h.newest_trade) : null;
    return c.json({ ok: true, env: c.env.ENV, db: "ok", dbMs, colo: c.req.raw.cf?.colo, indexer: { slot: Number(h.last_slot), cursorAge: now - Number(h.updated_at), newestTradeAge: lag }, now });
  } catch (e) {
    return c.json({ ok: false, env: c.env.ENV, db: "error", error: (e as Error).message, now }, 503);
  }
});

app.route("/v1", read);
app.route("/ingest", ingest);
app.route("/ws", ws);

app.notFound((c) => c.json({ error: "not found", requestId: c.req.header("cf-ray") ?? "" }, 404));
app.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message, requestId: c.req.header("cf-ray") ?? "" }, e.status as 400);
  console.error(e);
  return c.json({ error: "internal", requestId: c.req.header("cf-ray") ?? "" }, 500);
});

export default app;
