import type { Sql } from "../lib/db";

export type CandleRow = { t: number; o: number; h: number; l: number; c: number; v: number; n: number };
export type TradeRow = {
  signature: string; ix_index: number; slot: number; block_time: number; wallet: string; side: "buy" | "sell";
  base_raw: string; quote_raw: string; price_quote: number;
};

const TF_SEC: Record<string, number> = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };

export const marketRepo = {
  // 1m candles are stored; larger frames are rolled up in SQL from the 1m rows. Returned oldest → newest.
  candles: (sql: Sql, mint: string, tf: string, limit: number, before?: number) => {
    const step = TF_SEC[tf] ?? 60;
    const upper = before ? sql`AND minute < ${before}` : sql``;
    if (step === 60) return sql<CandleRow[]>`
      SELECT * FROM (
        SELECT minute AS t, o, h, l, c, vol_quote AS v, n FROM candles_1m
        WHERE token_mint = ${mint} ${upper} ORDER BY minute DESC LIMIT ${limit}) x ORDER BY t`;
    return sql<CandleRow[]>`
      SELECT * FROM (
        SELECT (minute / ${step}) * ${step} AS t,
               (array_agg(o ORDER BY minute))[1] AS o, max(h) AS h, min(l) AS l,
               (array_agg(c ORDER BY minute DESC))[1] AS c, sum(vol_quote) AS v, sum(n)::int AS n
        FROM candles_1m WHERE token_mint = ${mint} ${upper}
        GROUP BY 1 ORDER BY 1 DESC LIMIT ${limit}) x ORDER BY t`;
  },
  // Stock price line from stock_snapshots (one row per minute). Bucket size grows with the range so a
  // month is ~720 points, not 43k. First price in each bucket; mark is the fair value at that time.
  history: (sql: Sql, mint: string, from: number, step: number) => sql<{ t: number; price: number; mark: number | null }[]>`
      SELECT (ts / ${step}) * ${step} AS t,
             (array_agg(price_usd ORDER BY ts))[1] AS price, (array_agg(mark_usd ORDER BY ts))[1] AS mark
      FROM stock_snapshots WHERE mint = ${mint} AND ts >= ${from} AND price_usd IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  // Short ranges come from stock_ticks (5s Jupiter samples, 24h retention). No mark at tick resolution.
  ticks: (sql: Sql, mint: string, from: number, step: number) => sql<{ t: number; price: number; mark: null }[]>`
      SELECT (ts / ${step}) * ${step} AS t, (array_agg(price_usd ORDER BY ts))[1] AS price, NULL::float8 AS mark
      FROM stock_ticks WHERE mint = ${mint} AND ts >= ${from}
      GROUP BY 1 ORDER BY 1`,
  trades: (sql: Sql, mint: string, limit: number, before?: number) => {
    const upper = before ? sql`AND block_time < ${before}` : sql``;
    return sql<TradeRow[]>`
      SELECT signature, ix_index, slot, block_time, wallet, side, base_raw::text AS base_raw, quote_raw::text AS quote_raw, price_quote
      FROM trades WHERE token_mint = ${mint} ${upper} ORDER BY block_time DESC, slot DESC LIMIT ${limit}`;
  },
  health: async (sql: Sql) => (await sql<{ last_slot: number; updated_at: number; newest_trade: number | null }[]>`
    SELECT max(last_slot)::bigint AS last_slot, max(updated_at)::bigint AS updated_at,
           (SELECT block_time FROM trades ORDER BY block_time DESC LIMIT 1)::bigint AS newest_trade FROM cursor`)[0]!,
};
