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
import { simulateOrder } from "../services/orders";
import { listConfig, setConfig } from "../services/config";
import { ingestNews, scoreNews, jevProbe } from "../services/news";

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
  slippageBps: z.number().int().min(10).max(2000).optional(),
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
admin.post("/news/jev", async (c) => c.json(await jevProbe(c.env)));
admin.post("/news/score", async (c) =>
  c.json(await scoreNews(c.env, c.get("sql"), Number(c.req.query("limit") ?? 60))),
);
admin.post("/news/run", async (c) =>
  c.json(await ingestNews(c.env, c.get("sql"), Number(c.req.query("minute") ?? new Date().getUTCMinutes()))),
);
admin.get("/config", async (c) => c.json({ config: await listConfig(c.get("sql")) }));
admin.post("/config", async (c) => {
  const b = parse(
    z.object({ key: z.string().min(1).max(64), value: z.string().min(1).max(200) }),
    await c.req.json(),
  );
  return c.json(await setConfig(c.get("sql"), b.key, b.value));
});
admin.post("/order-simulate", async (c) =>
  c.json(
    await simulateOrder(
      c.env,
      c.get("sql"),
      parse(
        z.object({
          wallet: Mint,
          mint: Mint,
          side: z.enum(["buy", "sell"]),
          amount: z.string().regex(/^\d+$/),
          triggerUsd: z.number().positive(),
        }),
        await c.req.json(),
      ),
    ),
  ),
);
admin.post("/swap-simulate", async (c) =>
  c.json(await simulate(c.env, c.get("sql"), parse(SimBody, await c.req.json()))),
);
