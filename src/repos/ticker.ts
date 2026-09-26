import type { Sql } from "../lib/db";

type TickerRow = {
  id: string;
  label: string;
  logo: string | null;
  change24h: number | null;
  price: number | null;
};

export const tickerRepo = {
  // The busiest stonks by their own 24h volume, with live prices from the indexer.
  rows: (sql: Sql, stonks: number) => sql<TickerRow[]>`
    SELECT s.mint AS id, s.symbol AS label, s.logo, s.change_24h AS change24h, s.price_usd AS price
    FROM stocks s WHERE s.price_usd IS NOT NULL AND NOT s.excluded
    ORDER BY coalesce(s.vol_24h_usd, 0) DESC, coalesce(s.liquidity_usd, 0) DESC LIMIT ${stonks}`,
};
