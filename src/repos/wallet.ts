import type { Sql } from "../lib/db";

// What our tape knows about one wallet on one token: what it paid in and took out, in USD at trade time.
export type PositionRow = {
  token_mint: string; bought_raw: string; sold_raw: string; bought_usd: number; sold_usd: number; n: number; last_ts: number;
};
export type ActivityRow = {
  signature: string; block_time: number; side: "buy" | "sell"; token_mint: string; symbol: string | null; image: string | null;
  base_raw: string; quote_raw: string; quote_usd: number | null; decimals: number; quote_mint: string; stock_symbol: string;
  quote_decimals: number; stock_price_usd: number | null;
};

export const walletRepo = {
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
  known: (sql: Sql, mints: string[]) => sql<{ mint: string; kind: "stock" | "meme"; symbol: string | null; name: string | null; image: string | null; decimals: number; price_usd: number | null; change_24h: number | null; quote_symbol: string | null; multiplier: number }[]>`
    SELECT s.mint, 'stock' AS kind, s.symbol, s.name, s.logo AS image, s.decimals, s.price_usd, s.change_24h, NULL AS quote_symbol, s.multiplier
    FROM stocks s WHERE s.mint IN ${sql(mints)}
    UNION ALL
    SELECT t.mint, 'meme', t.symbol, t.name, t.image, t.decimals, st.price_usd, st.change_24h, q.symbol, 1
    FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint JOIN stocks q ON q.mint = t.quote_mint WHERE t.mint IN ${sql(mints)}`,
};
