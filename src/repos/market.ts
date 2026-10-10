import type { Sql } from "../lib/db";

export const marketRepo = {
  // Stock price line from stock_snapshots (one row per minute). Bucket size grows with the range so a
  // month is ~720 points, not 43k. First price in each bucket; mark is the fair value at that time.
  history: (sql: Sql, mint: string, from: number, step: number) => sql<
    { t: number; price: number; mark: number | null }[]
  >`
      SELECT (ts / ${step}) * ${step} AS t,
             (array_agg(price_usd ORDER BY ts))[1] AS price, (array_agg(mark_usd ORDER BY ts))[1] AS mark
      FROM stock_snapshots WHERE mint = ${mint} AND ts >= ${from} AND price_usd IS NOT NULL
      GROUP BY 1 ORDER BY 1`,
  // Short ranges come from stock_ticks (5s Jupiter samples, 24h retention). No mark at tick resolution.
  ticks: (sql: Sql, mint: string, from: number, step: number) => sql<
    { t: number; price: number; mark: null }[]
  >`
      SELECT (ts / ${step}) * ${step} AS t, (array_agg(price_usd ORDER BY ts))[1] AS price, NULL::float8 AS mark
      FROM stock_ticks WHERE mint = ${mint} AND ts >= ${from}
      GROUP BY 1 ORDER BY 1`,
  // The biggest stories on this token in the window, with its price when each came out and an hour later.
  events: (sql: Sql, mint: string, from: number, to: number, minImpact: number, limit: number) => sql<
    {
      id: string;
      title: string;
      source: string | null;
      url: string;
      published_at: string;
      impact: number;
      direction: string | null;
      p0: number | null;
      p1: number | null;
    }[]
  >`
      SELECT n.id, n.title, n.source, n.url, n.published_at, n.impact, n.direction,
        (SELECT price_usd FROM stock_snapshots WHERE mint = ${mint} AND price_usd > 0 AND ts <= n.published_at
          ORDER BY ts DESC LIMIT 1) AS p0,
        (SELECT price_usd FROM stock_snapshots WHERE mint = ${mint} AND price_usd > 0 AND ts <= n.published_at + 3600
          ORDER BY ts DESC LIMIT 1) AS p1
      FROM news n JOIN news_stocks ns ON ns.news_id = n.id
      WHERE ns.mint = ${mint} AND NOT n.junk AND n.impact >= ${minImpact} AND n.published_at BETWEEN ${from} AND ${to}
      ORDER BY n.impact DESC, n.published_at DESC LIMIT ${limit}`,
  health: async (sql: Sql) =>
    (
      await sql<{ last_slot: number; updated_at: number; newest_trade: number | null }[]>`
    SELECT max(last_slot)::bigint AS last_slot, max(updated_at)::bigint AS updated_at,
           (SELECT block_time FROM trades ORDER BY block_time DESC LIMIT 1)::bigint AS newest_trade FROM cursor`
    )[0]!,
};
