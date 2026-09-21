import type { Sql } from "../lib/db";
import { marketRepo } from "../repos/market";
import { tokensRepo } from "../repos/tokens";
import { notFound } from "../lib/errors";
import { shapeCandle, shapeTrade } from "./shape";
import type { CandlesResponse, TradesResponse, Timeframe, HistoryRange, HistoryResponse } from "../contract";
import type { z } from "zod";

// Chart ranges: how far back, and the bucket size that keeps each under ~750 points.
const RANGE = {
  "5m": { span: 300, step: 5 },
  "15m": { span: 900, step: 15 },
  "1h": { span: 3600, step: 60 },
  "1d": { span: 86400, step: 120 },
  "1w": { span: 604800, step: 900 },
  "1m": { span: 2592000, step: 3600 },
} as const;

export const market = {
  candles: async (
    sql: Sql,
    mint: string,
    tf: z.infer<typeof Timeframe>,
    limit: number,
    before?: number,
  ): Promise<z.infer<typeof CandlesResponse>> => {
    const rows = await marketRepo.candles(sql, mint, tf, limit, before);
    return { mint, tf, candles: rows.map(shapeCandle) };
  },

  history: async (
    sql: Sql,
    mint: string,
    range: z.infer<typeof HistoryRange>,
  ): Promise<z.infer<typeof HistoryResponse>> => {
    const { span, step } = RANGE[range];
    const to = Math.floor(Date.now() / 1000),
      from = to - span;
    const rows =
      step < 60
        ? await marketRepo.ticks(sql, mint, from, step)
        : await marketRepo.history(sql, mint, from, step);
    const first = rows[0]?.price,
      last = rows[rows.length - 1]?.price;
    const changeAbs = first != null && last != null ? last - first : null;
    return {
      mint,
      range,
      from,
      to,
      points: rows.map((r) => ({
        t: Number(r.t),
        price: Number(r.price),
        mark: r.mark == null ? null : Number(r.mark),
      })),
      changeAbs,
      changePct: changeAbs != null && first ? (changeAbs / first) * 100 : null,
    };
  },
  trades: async (
    sql: Sql,
    mint: string,
    limit: number,
    before?: number,
  ): Promise<z.infer<typeof TradesResponse>> => {
    const [t, rows] = await Promise.all([
      tokensRepo.withStock(sql, mint),
      marketRepo.trades(sql, mint, limit, before),
    ]);
    if (!t) throw notFound("token");
    return {
      mint,
      trades: rows.map((r) =>
        shapeTrade(
          r,
          t.decimals,
          t.stock.decimals,
          t.stock.price_usd == null ? null : Number(t.stock.price_usd) * Number(t.stock.multiplier ?? 1),
        ),
      ),
    };
  },
};
