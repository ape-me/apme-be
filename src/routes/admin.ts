import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb, type DbVars } from "../lib/db";
import { badRequest, unauthorized } from "../lib/errors";
import { Mint } from "../contract";
import { COLLECTION_IDS, pgArr } from "../services/collections";

// Operator overrides for the stock list. Writes stock_config (the indexer re-reads it every 10 min and
// resubscribes) and mirrors excluded/category/tags onto stocks so the API reflects the change at once.
const Patch = z.object({
  excluded: z.boolean().optional(),
  category: z.enum(["preipo", "stock", "etf", "crypto"]).nullable().optional(),
  tags: z.array(z.enum(COLLECTION_IDS as [string, ...string[]])).optional(),
  note: z.string().max(200).nullable().optional(),
});

export const admin = new Hono<{ Bindings: Env; Variables: DbVars }>();
admin.use("*", async (c, next) => {
  const t = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!c.env.ADMIN_TOKEN || t !== c.env.ADMIN_TOKEN) throw unauthorized();
  await next();
});
admin.use("*", withDb);

admin.get("/stocks", async (c) => {
  const sql = c.get("sql");
  const rows = await sql`SELECT s.mint, s.symbol, s.issuer, s.category, s.excluded, s.tags, c.note, c.updated_at
                         FROM stocks s LEFT JOIN stock_config c ON c.mint = s.mint ORDER BY s.excluded DESC, s.symbol`;
  return c.json({ stocks: rows });
});

admin.post("/stocks/:mint", async (c) => {
  const mint = Mint.safeParse(c.req.param("mint")); if (!mint.success) throw badRequest("bad mint");
  const p = Patch.safeParse(await c.req.json().catch(() => ({}))); if (!p.success) throw badRequest(p.error.issues.map((i) => i.message).join("; "));
  const sql = c.get("sql"); const now = Math.floor(Date.now() / 1000); const b = p.data;
  // Array params 500 through Hyperdrive (same as the issuer filter), so tags travel as a csv scalar and are split in SQL.
  const [cur] = await sql`SELECT excluded, category, tags, note FROM stock_config WHERE mint = ${mint.data}`;
  const next = { excluded: b.excluded ?? cur?.excluded ?? false, category: b.category === undefined ? cur?.category ?? null : b.category, tags: b.tags ?? pgArr(cur?.tags), note: b.note === undefined ? cur?.note ?? null : b.note };
  const csv = next.tags.join(",");
  await sql`INSERT INTO stock_config (mint, excluded, category, tags, note, updated_at) VALUES (${mint.data}, ${next.excluded}, ${next.category}, COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), ${next.note}, ${now})
            ON CONFLICT (mint) DO UPDATE SET excluded = ${next.excluded}, category = ${next.category}, tags = COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), note = ${next.note}, updated_at = ${now}`;
  const [row] = await sql`UPDATE stocks SET excluded = ${next.excluded}, tags = COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), category = COALESCE(${next.category}, category) WHERE mint = ${mint.data} RETURNING mint, symbol, category, excluded, tags`;
  return c.json({ ok: true, config: { mint: mint.data, ...next }, stock: row ?? null, note: "indexer applies subscription changes within 10 min" });
});
