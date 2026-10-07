import type { Sql } from "../lib/db";

export type BasketLeg = {
  basket_id: string;
  wallet: string;
  side: string;
  input_mint: string;
  output_mint: string;
  in_raw: string;
  out_raw: string | null;
  in_usd: number | null;
  created_at: string;
};

export const basketsRepo = {
  insertOrder: (
    sql: Sql,
    o: {
      id: string;
      userId: string;
      wallet: string;
      basketId: string;
      side: string;
      amountUsd: number;
      t: number;
    },
  ) => sql`INSERT INTO basket_orders (id, user_id, wallet, basket_id, side, amount_usd, created_at)
           VALUES (${o.id}, ${o.userId}, ${o.wallet}, ${o.basketId}, ${o.side}, ${o.amountUsd}, ${o.t})`,
  order: (sql: Sql, id: string, userId: string) =>
    sql<{ id: string }[]>`SELECT id FROM basket_orders WHERE id = ${id} AND user_id = ${userId}`,
  legIds: (sql: Sql, orderId: string) =>
    sql<{ id: string }[]>`SELECT id FROM swaps WHERE basket_order_id = ${orderId}`,
  setStatus: (sql: Sql, id: string, status: string) =>
    sql`UPDATE basket_orders SET status = ${status} WHERE id = ${id}`,
  // Every confirmed swap a user made inside a basket: what each basket bought, sold, and paid.
  legs: (sql: Sql, userId: string) => sql<BasketLeg[]>`
    SELECT o.basket_id, s.wallet, s.side, s.input_mint, s.output_mint, s.in_raw, s.out_raw, s.in_usd, o.created_at
    FROM swaps s JOIN basket_orders o ON o.id = s.basket_order_id
    WHERE o.user_id = ${userId} AND s.status = 'confirmed' ORDER BY o.created_at`,
  closes: (sql: Sql, tickers: readonly string[], from: number) =>
    sql<{ ticker: string; ts: string; close: number }[]>`
      SELECT ticker, ts, close FROM daily_closes WHERE ticker IN ${sql(tickers)} AND ts >= ${from} ORDER BY ts`,
  upsertCloses: (sql: Sql, ticker: string, rows: { ts: number; close: number }[]) =>
    sql`INSERT INTO daily_closes ${sql(rows.map((r) => ({ ticker, ...r })))}
        ON CONFLICT (ticker, ts) DO UPDATE SET close = EXCLUDED.close`,
  // Private companies have no exchange closes: the last price we saw each day on their deepest token stands in.
  closesFromSnapshots: (sql: Sql, ticker: string) => sql`
    INSERT INTO daily_closes (ticker, ts, close)
    SELECT ${ticker}, (ts / 86400) * 86400, (array_agg(price_usd ORDER BY ts DESC))[1] FROM stock_snapshots
    WHERE price_usd IS NOT NULL AND mint = (SELECT mint FROM stocks WHERE coalesce(underlying, symbol) = ${ticker}
      AND NOT excluded ORDER BY coalesce(liquidity_usd, 0) DESC LIMIT 1)
    GROUP BY 2 ON CONFLICT (ticker, ts) DO UPDATE SET close = EXCLUDED.close`,
};
