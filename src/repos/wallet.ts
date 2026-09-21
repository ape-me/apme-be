import type { Sql } from "../lib/db";

// What our tape knows about one wallet on one token: what it paid in and took out, in USD at trade time.
type PositionRow = {
  token_mint: string;
  bought_raw: string;
  sold_raw: string;
  bought_usd: number;
  sold_usd: number;
  n: number;
  last_ts: number;
};
type ActivityRow = {
  signature: string;
  block_time: number;
  side: "buy" | "sell";
  token_mint: string;
  symbol: string | null;
  image: string | null;
  base_raw: string;
  quote_raw: string;
  quote_usd: number | null;
  decimals: number;
  quote_mint: string;
  stock_symbol: string;
  quote_decimals: number;
  stock_price_usd: number | null;
};

type SwapPositionRow = {
  mint: string;
  bought_raw: string;
  sold_raw: string;
  bought_usd: number;
  sold_usd: number;
};
type SwapActivityRow = {
  id: string;
  signature: string | null;
  side: "buy" | "sell";
  status: string;
  error: string | null;
  created_at: string;
  confirmed_at: string | null;
  input_mint: string;
  output_mint: string;
  in_raw: string;
  out_raw: string | null;
  in_usd: number | null;
  out_usd: number | null;
  fee_usd: number | null;
  symbol: string | null;
};

export const walletRepo = {
  // Our own swaps (USDC ↔ token) grouped per token: what this wallet paid in USD and got in raw units, and vice versa.
  swapPositions: (sql: Sql, wallet: string) => sql<SwapPositionRow[]>`
    SELECT mint, coalesce(sum(b_raw),0)::text AS bought_raw, coalesce(sum(s_raw),0)::text AS sold_raw, coalesce(sum(b_usd),0) AS bought_usd, coalesce(sum(s_usd),0) AS sold_usd FROM (
      SELECT output_mint AS mint, out_raw AS b_raw, 0 AS s_raw, in_usd AS b_usd, 0 AS s_usd FROM swaps WHERE wallet = ${wallet} AND status = 'confirmed' AND side = 'buy'
      UNION ALL
      SELECT input_mint, 0, in_raw, 0, out_usd FROM swaps WHERE wallet = ${wallet} AND status = 'confirmed' AND side = 'sell') x GROUP BY mint`,
  swapActivity: (sql: Sql, wallet: string, limit: number) => sql<SwapActivityRow[]>`
    SELECT id, signature, side, status, error, created_at, confirmed_at, input_mint, output_mint, in_raw::text AS in_raw, out_raw::text AS out_raw, in_usd, out_usd, fee_usd, symbol
    FROM swaps WHERE wallet = ${wallet} AND status <> 'quoted' ORDER BY created_at DESC LIMIT ${limit}`,
  positions: (sql: Sql, wallet: string) => sql<PositionRow[]>`
    SELECT token_mint,
           sum(base_raw) FILTER (WHERE side = 'buy')::text AS bought_raw, sum(base_raw) FILTER (WHERE side = 'sell')::text AS sold_raw,
           coalesce(sum(quote_usd_at) FILTER (WHERE side = 'buy'), 0) AS bought_usd, coalesce(sum(quote_usd_at) FILTER (WHERE side = 'sell'), 0) AS sold_usd,
           count(*)::int AS n, max(block_time) AS last_ts
    FROM (SELECT tr.*, tr.quote_raw::float8 / power(10, s.decimals) * coalesce(tr.quote_usd, s.price_usd) AS quote_usd_at
          FROM trades tr JOIN tokens t ON t.mint = tr.token_mint JOIN stocks s ON s.mint = t.quote_mint WHERE tr.wallet = ${wallet}) x
    GROUP BY token_mint`,
  activity: (sql: Sql, wallet: string, limit: number) => sql<ActivityRow[]>`
    SELECT tr.signature, tr.block_time, tr.side, tr.token_mint, t.symbol, t.image, tr.base_raw::text AS base_raw, tr.quote_raw::text AS quote_raw,
           tr.quote_usd, t.decimals, t.quote_mint, s.symbol AS stock_symbol, s.decimals AS quote_decimals, s.price_usd * s.multiplier AS stock_price_usd
    FROM trades tr JOIN tokens t ON t.mint = tr.token_mint JOIN stocks s ON s.mint = t.quote_mint
    WHERE tr.wallet = ${wallet} ORDER BY tr.block_time DESC LIMIT ${limit}`,
  // Everything we can price among a wallet's mints: stocks and memes, in one round trip.
  known: (sql: Sql, mints: string[]) => sql<
    {
      mint: string;
      kind: "stock" | "meme";
      symbol: string | null;
      name: string | null;
      image: string | null;
      decimals: number;
      price_usd: number | null;
      change_24h: number | null;
      quote_symbol: string | null;
      multiplier: number;
    }[]
  >`
    SELECT s.mint, 'stock' AS kind, s.symbol, s.name, s.logo AS image, s.decimals, s.price_usd, s.change_24h, NULL AS quote_symbol, s.multiplier
    FROM stocks s WHERE s.mint IN ${sql(mints)}
    UNION ALL
    SELECT t.mint, 'meme', t.symbol, t.name, t.image, t.decimals, st.price_usd, st.change_24h, q.symbol, 1
    FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint JOIN stocks q ON q.mint = t.quote_mint WHERE t.mint IN ${sql(mints)}`,
};
