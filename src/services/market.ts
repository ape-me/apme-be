import type { Sql } from "../lib/db";
import { marketRepo } from "../repos/market";
import { tokensRepo } from "../repos/tokens";
import { stocksRepo } from "../repos/stocks";
import { notFound } from "../lib/errors";
import { shapeCandle, shapeTrade } from "./shape";
import type { CandlesResponse, TradesResponse, Timeframe } from "../contract";
import type { z } from "zod";

export const market = {
  candles: async (sql: Sql, mint: string, tf: z.infer<typeof Timeframe>, limit: number, before?: number): Promise<z.infer<typeof CandlesResponse>> => {
    const rows = await marketRepo.candles(sql, mint, tf, limit, before);
    return { mint, tf, candles: rows.map(shapeCandle) };
  },

  trades: async (sql: Sql, mint: string, limit: number, before?: number): Promise<z.infer<typeof TradesResponse>> => {
    const t = await tokensRepo.byMint(sql, mint);
    if (!t) throw notFound("token");
    const s = await stocksRepo.byMint(sql, t.quote_mint);
    const rows = await marketRepo.trades(sql, mint, limit, before);
    return { mint, trades: rows.map((r) => shapeTrade(r, t.decimals, s?.decimals ?? 8, s?.price_usd ?? null)) };
  },
};
