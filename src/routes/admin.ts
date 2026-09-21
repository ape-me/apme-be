import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb, type DbVars } from "../middleware/db";
import { requireAdmin } from "../middleware/auth";
import { parse } from "../lib/validate";
import { Mint } from "../contract";
import { COLLECTION_IDS } from "../services/collections";
import { patchStock } from "../services/admin";
import { mintAdminCodes } from "../services/account";
import { accountRepo } from "../repos/account";
import { stocksRepo } from "../repos/stocks";
import { gasInfo, simulate } from "../services/swap";

const Patch = z.object({
  excluded: z.boolean().optional(),
  category: z.enum(["preipo", "stock", "etf", "crypto"]).nullable().optional(),
  tags: z.array(z.enum(COLLECTION_IDS as [string, ...string[]])).optional(),
  note: z.string().max(200).nullable().optional(),
});
const InviteBody = z.object({
  count: z.number().int().min(1).max(200).default(1),
  maxUses: z.number().int().min(1).max(10000).default(1),
  label: z.string().max(60).optional(),
  expiresAt: z.number().int().nullable().optional(),
});
const SimBody = z.object({
  inputMint: z.string(),
  outputMint: z.string(),
  amount: z.string().regex(/^\d+$/),
  taker: Mint,
});

export const admin = new Hono<{ Bindings: Env; Variables: DbVars }>();
admin.use("*", requireAdmin, withDb);

admin.get("/stocks", async (c) => c.json({ stocks: await stocksRepo.withConfig(c.get("sql")) }));
admin.post("/stocks/:mint", async (c) =>
  c.json(
    await patchStock(
      c.get("sql"),
      parse(Mint, c.req.param("mint")),
      parse(Patch, await c.req.json().catch(() => ({}))),
    ),
  ),
);

admin.get("/invites", async (c) => c.json({ invites: await accountRepo.listInvites(c.get("sql")) }));
admin.post("/invites", async (c) => {
  const b = parse(InviteBody, await c.req.json());
  const codes = await mintAdminCodes(c.get("sql"), b.count, b.maxUses, b.label ?? null, b.expiresAt ?? null);
  return c.json({ codes, maxUses: b.maxUses, label: b.label ?? null });
});

admin.get("/gas", async (c) => c.json(await gasInfo(c.env)));
admin.post("/swap-simulate", async (c) =>
  c.json(await simulate(c.env, c.get("sql"), parse(SimBody, await c.req.json()))),
);
