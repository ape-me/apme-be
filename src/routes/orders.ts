import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb } from "../middleware/db";
import { requireAuth, requireActive, type AuthVars } from "../middleware/auth";
import { parse } from "../lib/validate";
import { Mint } from "../contract";
import { quoteOrder, submitOrder, cancelOrder, submitCancel, listOrders } from "../services/orders";

const QuoteBody = z.object({
  wallet: Mint,
  mint: Mint,
  side: z.enum(["buy", "sell"]),
  amount: z.string().regex(/^\d+$/, "raw integer units of the mint you are giving"),
  triggerUsd: z.number().positive(),
});
const Signed = z.object({ signedTransaction: z.string().min(100) });

export const orders = new Hono<{ Bindings: Env; Variables: AuthVars }>();
orders.use("*", withDb, requireAuth, requireActive);

orders.get("/", async (c) =>
  c.json(
    await listOrders(
      c.env,
      c.get("sql"),
      c.get("user"),
      c.get("wallets"),
      Math.min(100, Number(c.req.query("limit") ?? 50)),
    ),
  ),
);

orders.post("/quote", async (c) =>
  c.json(
    await quoteOrder(
      c.env,
      c.get("sql"),
      c.get("user"),
      c.get("wallets"),
      parse(QuoteBody, await c.req.json()),
    ),
  ),
);

orders.post("/:id/submit", async (c) =>
  c.json(
    await submitOrder(
      c.env,
      c.get("sql"),
      c.get("user"),
      c.req.param("id"),
      parse(Signed, await c.req.json()).signedTransaction,
    ),
  ),
);

orders.post("/:id/cancel", async (c) =>
  c.json(await cancelOrder(c.env, c.get("sql"), c.get("user"), c.req.param("id"))),
);

orders.post("/:id/cancel/submit", async (c) =>
  c.json(
    await submitCancel(
      c.env,
      c.get("sql"),
      c.get("user"),
      c.req.param("id"),
      parse(Signed, await c.req.json()).signedTransaction,
    ),
  ),
);
