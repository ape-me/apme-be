import type { Sql } from "../lib/db";
import { stocksRepo, type StockConfig } from "../repos/stocks";
import { pgArr } from "./collections";

export type StockPatch = {
  excluded?: boolean;
  category?: string | null;
  tags?: string[];
  note?: string | null;
};

// Operator override: merge onto stock_config (indexer re-reads every 10 min) and mirror onto stocks now.
export async function patchStock(sql: Sql, mint: string, b: StockPatch) {
  const cur = await stocksRepo.config(sql, mint);
  const next: StockConfig = {
    excluded: b.excluded ?? cur?.excluded ?? false,
    category: b.category === undefined ? (cur?.category ?? null) : b.category,
    tags: b.tags ?? pgArr(cur?.tags),
    note: b.note === undefined ? (cur?.note ?? null) : b.note,
  };
  const csv = (next.tags as string[]).join(",");
  const now = Math.floor(Date.now() / 1000);
  await stocksRepo.upsertConfig(sql, mint, next, csv, now);
  const stock = await stocksRepo.applyConfig(sql, mint, next, csv);
  return {
    ok: true,
    config: { mint, ...next },
    stock,
    note: "indexer applies subscription changes within 10 min",
  };
}
