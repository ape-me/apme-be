import { Hono } from "hono";
import { z } from "zod";
import type { Context } from "hono";
import type { Env } from "../env";
import { withDb } from "../middleware/db";
import { rateLimited } from "../middleware/ratelimit";
import { requireAuth, requireActive, requireAiEval, requireRegion, type AuthVars } from "../middleware/auth";
import { cached } from "../lib/cache";
import { parse } from "../lib/validate";
import { Mint } from "../contract";
import {
  basketList,
  basketDetail,
  basketNews,
  basketPreview,
  quoteBuy,
  quoteSell,
  retryBuy,
  submitBasket,
} from "../services/baskets";
import { buildBasket, evalIdea, ideaChips } from "../services/ai";

type C = Context<{ Bindings: Env; Variables: AuthVars }>;
const ctx = (c: C) => ({
  env: c.env,
  sql: c.get("sql"),
  user: c.get("user"),
  wallets: c.get("wallets"),
  settings: c.get("settings"),
});
const trade = [withDb, requireRegion, requireAuth, requireActive] as const;
// A mix: ticker -> %, rescaled to 100; 0 drops a stock.
const Weights = z
  .record(z.string().max(24), z.number().min(0).max(100))
  .refine((w) => Object.keys(w).length <= 10, "too many tickers");

export const baskets = new Hono<{ Bindings: Env; Variables: AuthVars }>();

baskets.get("/", rateLimited, withDb, (c) =>
  cached(c.req.raw, 60, async () => c.json(await basketList(c.get("sql")))),
);
// AI routes sit before /:id so "ai" is never read as a basket id.
baskets.get("/ai/ideas", rateLimited, withDb, (c) =>
  cached(c.req.raw, 3600, async () => c.json(await ideaChips(c.env, c.get("sql")))),
);
baskets.post("/ai", rateLimited, withDb, requireAuth, async (c) => {
  const b = parse(z.object({ idea: z.string().trim().min(3).max(200) }), await c.req.json());
  return c.json(await buildBasket(c.env, c.get("sql"), c.get("user"), b.idea));
});
baskets.post("/ai/eval", requireAiEval, withDb, async (c) => {
  const b = parse(z.object({ idea: z.string().trim().min(3).max(200) }), await c.req.json());
  return c.json(await evalIdea(c.env, c.get("sql"), b.idea));
});

// Handlers shared by public baskets and AI ones, which only their signed-in author can open (and never edge-cached).
const AI_ID = "/:id{ai_[a-z0-9]+}";
const own = [rateLimited, withDb, requireAuth] as const;
const viewer = (c: C) => (c.req.param("id")?.startsWith("ai_") ? c.get("user")?.id : undefined);
const newsOf = async (c: C) => {
  const limit = parse(z.coerce.number().int().min(1).max(50).default(20), c.req.query("limit"));
  return c.json(await basketNews(c.get("sql"), c.req.param("id")!, limit, viewer(c)));
};
const detailOf = async (c: C) => c.json(await basketDetail(c.get("sql"), c.req.param("id")!, viewer(c)));
const previewOf = async (c: C) => {
  const b = parse(z.object({ weights: Weights }), await c.req.json());
  return c.json(await basketPreview(c.get("sql"), c.req.param("id")!, b.weights, viewer(c)));
};
baskets.get(`${AI_ID}/news`, ...own, newsOf);
baskets.get(AI_ID, ...own, detailOf);
baskets.post(`${AI_ID}/preview`, ...own, previewOf);
baskets.get("/:id/news", rateLimited, withDb, (c) => cached(c.req.raw, 60, () => newsOf(c)));
baskets.get("/:id", rateLimited, withDb, (c) => cached(c.req.raw, 60, () => detailOf(c)));
baskets.post("/:id/preview", rateLimited, withDb, previewOf);

baskets.post("/:id/quote", ...trade, async (c) => {
  const b = parse(
    z.object({ amountUsd: z.number().positive().max(100_000), taker: Mint, weights: Weights.optional() }),
    await c.req.json(),
  );
  return c.json(await quoteBuy(ctx(c), c.req.param("id"), b.amountUsd, b.taker, b.weights));
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
