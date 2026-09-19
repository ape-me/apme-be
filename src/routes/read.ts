import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb, type DbVars } from "../lib/db";
import { rateLimited } from "../lib/ratelimit";
import { cached } from "../lib/cache";
import { badRequest } from "../lib/errors";
import { Mint, Timeframe, Sort, Column, Limit, Cursor, TokenFilters, Issuer, HistoryRange } from "../contract";
import { catalog } from "../services/catalog";
import { market } from "../services/market";
import { wallet } from "../services/portfolio";
import { COLLECTION_IDS } from "../services/collections";

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
  return r.data;
};

export const read = new Hono<{ Bindings: Env; Variables: DbVars }>();
read.use("*", rateLimited, withDb);

read.get("/ticker", (c) => cached(c.req.raw, 3, async () => {
  const q = parse(z.object({ stonks: Limit.default(10), memes: Limit.default(10) }), c.req.query());
  return c.json(await catalog.ticker(c.get("sql"), q.stonks, q.memes));
}));

read.get("/stocks", (c) => cached(c.req.raw, 5, async () => {
  // ?issuer=prestocks  or  ?issuer=xstocks,backpack
  const q = parse(z.object({ issuer: z.string().optional(), collection: z.enum(COLLECTION_IDS as [string, ...string[]]).optional() }), c.req.query());
  const issuers = q.issuer ? parse(z.array(Issuer), q.issuer.split(",")) : undefined;
  return c.json(await catalog.stocks(c.get("sql"), issuers, q.collection));
}));

read.get("/collections", (c) => cached(c.req.raw, 10, async () => c.json(await catalog.collections(c.get("sql")))));
read.get("/movers", (c) => cached(c.req.raw, 10, async () => {
  const q = parse(z.object({ limit: Limit.default(5) }), c.req.query());
  return c.json(await catalog.movers(c.get("sql"), q.limit));
}));

read.get("/stocks/:mint/history", (c) => cached(c.req.raw, 30, async () => {
  const mint = parse(Mint, c.req.param("mint"));
  const q = parse(z.object({ range: HistoryRange.default("1d") }), c.req.query());
  return c.json(await market.history(c.get("sql"), mint, q.range));
}));

// Portfolio tab. Address = the user's Privy wallet. Chain read + our tape, so 5s cache is plenty.
read.get("/wallet/:address", (c) => cached(c.req.raw, 5, async () => {
  const address = parse(Mint, c.req.param("address"));
  const q = parse(z.object({ activity: Limit.default(50) }), c.req.query());
  return c.json(await wallet(c.env, c.get("sql"), address, q.activity));
}));

read.get("/stocks/:mint", (c) => cached(c.req.raw, 5, async () => c.json(await catalog.stock(c.get("sql"), parse(Mint, c.req.param("mint"))))));

const ListQuery = TokenFilters.extend({ column: Column.optional(), sort: Sort.optional(), limit: Limit.default(50), cursor: Cursor });

read.get("/stocks/:mint/tokens", (c) => cached(c.req.raw, 3, async () => {
  const mint = parse(Mint, c.req.param("mint"));
  const { column, sort, limit, cursor, ...filters } = parse(ListQuery, c.req.query());
  return c.json(await catalog.stockTokens(c.get("sql"), mint, { column, sort, limit, cursor, filters }));
}));

read.get("/tokens", (c) => cached(c.req.raw, 3, async () => {
  const { column, sort, limit, cursor, ...filters } = parse(ListQuery.extend({ stock: Mint.optional() }), c.req.query());
  const { stock, ...rest } = filters as typeof filters & { stock?: string };
  return c.json(await catalog.list(c.get("sql"), { stock, column, sort, limit, cursor, filters: rest }));
}));

read.get("/floor", (c) => cached(c.req.raw, 3, async () => {
  const { stock, limit, ...filters } = parse(TokenFilters.extend({ stock: Mint.optional(), limit: Limit.default(30) }), c.req.query());
  return c.json(await catalog.floor(c.get("sql"), { stock, limit, filters }));
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
