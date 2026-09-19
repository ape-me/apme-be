import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Env } from "./env";
import { HttpError } from "./lib/errors";
import { withDb, type DbVars } from "./lib/db";
import { marketRepo } from "./repos/market";
import { read } from "./routes/read";
import { ingest } from "./routes/ingest";
import { ws } from "./routes/ws";
import { apelistRoute } from "./routes/apelist";

export { Room } from "./do/room";

const app = new Hono<{ Bindings: Env; Variables: DbVars }>();

app.use("*", async (c, next) => c.req.path.startsWith("/api/apelist") ? next() : cors({ origin: "*", allowMethods: ["GET", "POST"], maxAge: 86400 })(c, next));
app.use("*", async (c, next) => {
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  await next();
});

app.get("/", (c) => c.json({
  name: "apme-be",
  health: "/health",
  reads: ["/v1/ticker?stonks=10&memes=10", "/v1/floor?stock=&limit=30&<filters>", "/v1/tokens?column=new|graduating|graduated&stock=&sort=&limit&cursor&<filters>", "/v1/stocks", "/v1/stocks/:mint/tokens?sort=volume|new|mcap&limit&cursor", "/v1/tokens/:mint", "/v1/tokens/:mint/candles?tf=1m|5m|15m|1h|4h|1d&limit&before", "/v1/tokens/:mint/trades?limit&before"],
  live: ["wss: /ws/floor", "wss: /ws/:mint"],
  apelist: ["POST /api/apelist", "GET /api/apelist/count", "GET /api/apelist/confirm?t="],
  ops: ["GET /health", "GET /metrics (bearer)"],
}));

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

// Prometheus text format for the ops box: numbers that live in D1, not Postgres (waitlist).
app.get("/metrics", async (c) => {
  if (!c.env.METRICS_TOKEN || c.req.header("authorization") !== `Bearer ${c.env.METRICS_TOKEN}`) return c.text("unauthorized", 401);
  const r = await c.env.DB.prepare("SELECT COUNT(*) AS total, SUM(confirmed_at IS NOT NULL) AS confirmed FROM apelist").first<{ total: number; confirmed: number }>();
  const lines = [
    "# TYPE apeme_apelist_signups_total gauge", `apeme_apelist_signups_total ${r?.total ?? 0}`,
    "# TYPE apeme_apelist_confirmed_total gauge", `apeme_apelist_confirmed_total ${r?.confirmed ?? 0}`,
  ];
  return c.text(lines.join("\n") + "\n", 200, { "content-type": "text/plain; version=0.0.4" });
});

app.route("/api/apelist", apelistRoute);
app.route("/v1", read);
app.route("/api", read);   // alias, same handlers
app.route("/ingest", ingest);
app.route("/ws", ws);

app.notFound((c) => c.json({ error: "not found", requestId: c.req.header("cf-ray") ?? "" }, 404));
app.onError((e, c) => {
  if (e instanceof HttpError) return c.json({ error: e.message, requestId: c.req.header("cf-ray") ?? "" }, e.status as 400);
  console.error(e);
  return c.json({ error: "internal", requestId: c.req.header("cf-ray") ?? "" }, 500);
});

export default app;
