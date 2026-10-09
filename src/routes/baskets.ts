import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { Env } from "../env";
import { withDb } from "../middleware/db";
import { rateLimited } from "../middleware/ratelimit";
import { requireAuth, requireActive, requireRegion, type AuthVars } from "../middleware/auth";
import { cached } from "../lib/cache";
import { parse } from "../lib/validate";
import { Mint } from "../contract";
import {
  basketList,
  basketDetail,
  basketNews,
  quoteBuy,
  quoteSell,
  retryBuy,
  submitBasket,
} from "../services/baskets";

type C = Context<{ Bindings: Env; Variables: AuthVars }>;
const ctx = (c: C) => ({
  env: c.env,
  sql: c.get("sql"),
  user: c.get("user"),
  wallets: c.get("wallets"),
  settings: c.get("settings"),
});
const trade = [withDb, requireRegion, requireAuth, requireActive] as const;

export const baskets = new Hono<{ Bindings: Env; Variables: AuthVars }>();

baskets.get("/", rateLimited, withDb, (c) =>
  cached(c.req.raw, 60, async () => c.json(await basketList(c.get("sql")))),
);
baskets.get("/:id/news", rateLimited, withDb, (c) =>
  cached(c.req.raw, 60, async () => {
    const limit = parse(z.coerce.number().int().min(1).max(50).default(20), c.req.query("limit"));
    return c.json(await basketNews(c.get("sql"), c.req.param("id"), limit));
  }),
);
baskets.get("/:id", rateLimited, withDb, (c) =>
  cached(c.req.raw, 60, async () => c.json(await basketDetail(c.get("sql"), c.req.param("id")))),
);

baskets.post("/:id/quote", ...trade, async (c) => {
  const b = parse(
    z.object({ amountUsd: z.number().positive().max(100_000), taker: Mint }),
    await c.req.json(),
  );
  return c.json(await quoteBuy(ctx(c), c.req.param("id"), b.amountUsd, b.taker));
});

baskets.post("/:id/sell", ...trade, async (c) => {
  const b = parse(z.object({ taker: Mint }), await c.req.json());
  return c.json(await quoteSell(ctx(c), c.req.param("id"), b.taker));
});

baskets.post("/orders/:orderId/submit", ...trade, async (c) => {
  const b = parse(
    z.object({
      signed: z
        .array(z.object({ requestId: z.string().uuid(), signedTransaction: z.string().min(100) }))
        .min(1)
        .max(10),
    }),
    await c.req.json(),
  );
  const orderId = parse(z.string().uuid(), c.req.param("orderId"));
  return c.json(await submitBasket(c.env, c.get("sql"), c.get("user"), orderId, b.signed));
});

baskets.post("/orders/:orderId/retry", ...trade, async (c) =>
  c.json(await retryBuy(ctx(c), parse(z.string().uuid(), c.req.param("orderId")))),
);
