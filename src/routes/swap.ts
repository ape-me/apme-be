import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb } from "../lib/db";
import { badRequest } from "../lib/errors";
import { Mint } from "../contract";
import { requireAuth, requireActive, type AuthVars } from "./me";
import { quote, submit, txStatus } from "../services/swap";

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
  return r.data;
};

const MintOrAlias = z.union([Mint, z.enum(["usdc", "native"])]);
const QuoteBody = z.object({
  inputMint: MintOrAlias, outputMint: MintOrAlias, amount: z.string().regex(/^\d+$/, "raw integer units of inputMint"), taker: Mint,
  slippageBps: z.number().int().min(10).max(500).optional(), priority: z.enum(["normal", "fast", "turbo"]).optional(),
});

export const swap = new Hono<{ Bindings: Env; Variables: AuthVars }>();
swap.use("*", withDb, requireAuth, requireActive);

swap.post("/quote", async (c) => {
  const b = parse(QuoteBody, await c.req.json());
  const { _rentMints, ...res } = await quote(c.env, c.get("sql"), c.get("user"), c.get("wallets"), c.get("settings"), b);
  return c.json(res);
});

swap.post("/submit", async (c) => {
  const b = parse(z.object({ requestId: z.string().uuid(), signedTransaction: z.string().min(100) }), await c.req.json());
  return c.json(await submit(c.env, c.get("sql"), c.get("user"), b.requestId, b.signedTransaction));
});

// Public: anyone can check a signature. Settles our swaps row when it belongs to us.
export const tx = new Hono<{ Bindings: Env }>();
tx.use("*", withDb);
tx.get("/:signature", async (c) => {
  const sig = parse(z.string().min(80).max(90), c.req.param("signature"));
  return c.json(await txStatus(c.env, c.get("sql" as never) as never, sig));
});
