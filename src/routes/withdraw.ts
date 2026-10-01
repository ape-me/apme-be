import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb } from "../middleware/db";
import { requireAuth, requireActive, requireRegion, type AuthVars } from "../middleware/auth";
import { parse } from "../lib/validate";
import { Mint } from "../contract";
import { quote, submit, status } from "../services/withdraw";

const QuoteBody = z.object({
  from: Mint,
  mint: z.union([Mint, z.enum(["usdc", "native"])]),
  amount: z.string().regex(/^\d+$/, "raw integer units of mint"),
  to: Mint,
});

export const withdraw = new Hono<{ Bindings: Env; Variables: AuthVars }>();
withdraw.use("*", withDb, requireRegion, requireAuth, requireActive);

withdraw.post("/quote", async (c) => {
  const b = parse(QuoteBody, await c.req.json());
  return c.json(await quote(c.env, c.get("sql"), c.get("user"), c.get("wallets"), b));
});

withdraw.post("/submit", async (c) => {
  const b = parse(
    z.object({ requestId: z.string().uuid(), signedTransaction: z.string().min(100) }),
    await c.req.json(),
  );
  return c.json(await submit(c.env, c.get("sql"), c.get("user"), b.requestId, b.signedTransaction));
});

withdraw.get("/:requestId", async (c) => {
  const id = parse(z.string().uuid(), c.req.param("requestId"));
  return c.json(await status(c.env, c.get("sql"), c.get("user"), id));
});
