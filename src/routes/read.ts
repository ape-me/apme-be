import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb, type DbVars } from "../lib/db";
import { rateLimited } from "../lib/ratelimit";
import { cached } from "../lib/cache";
import { badRequest } from "../lib/errors";
import { Mint, Timeframe, Sort, Limit, Cursor } from "../contract";
import { catalog } from "../services/catalog";
import { market } from "../services/market";

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
  return r.data;
};

export const read = new Hono<{ Bindings: Env; Variables: DbVars }>();
read.use("*", rateLimited, withDb);

read.get("/stocks", (c) => cached(c.req.raw, 5, async () => c.json(await catalog.stocks(c.get("sql")))));

read.get("/stocks/:mint/tokens", (c) => cached(c.req.raw, 3, async () => {
  const mint = parse(Mint, c.req.param("mint"));
  const q = parse(z.object({ sort: Sort.default("volume"), limit: Limit.default(50), cursor: Cursor }), c.req.query());
  return c.json(await catalog.stockTokens(c.get("sql"), mint, q.sort, q.limit, q.cursor));
}));

read.get("/tokens/:mint", (c) => cached(c.req.raw, 3, async () =>
  c.json(await catalog.token(c.get("sql"), parse(Mint, c.req.param("mint"))))));

read.get("/tokens/:mint/candles", (c) => cached(c.req.raw, 2, async () => {
  const mint = parse(Mint, c.req.param("mint"));
  const q = parse(z.object({ tf: Timeframe.default("1m"), limit: Limit.default(300), before: z.coerce.number().int().optional() }), c.req.query());
  return c.json(await market.candles(c.get("sql"), mint, q.tf, q.limit, q.before));
}));

read.get("/tokens/:mint/trades", (c) => cached(c.req.raw, 2, async () => {
  const mint = parse(Mint, c.req.param("mint"));
  const q = parse(z.object({ limit: Limit.default(100), before: z.coerce.number().int().optional() }), c.req.query());
  return c.json(await market.trades(c.get("sql"), mint, q.limit, q.before));
}));
