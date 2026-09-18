import type { Sql } from "../lib/db";

export type StockRow = {
  mint: string; symbol: string; name: string; issuer: string; category: string; decimals: number;
  logo: string | null; price_usd: number | null; change_24h: number | null; memes?: number;
};

export const stocksRepo = {
  all: (sql: Sql) => sql<StockRow[]>`
    SELECT s.mint, s.symbol, s.name, s.issuer, s.category, s.decimals, s.logo, s.price_usd, s.change_24h,
           (SELECT count(*)::int FROM tokens t WHERE t.quote_mint = s.mint) AS memes
    FROM stocks s ORDER BY memes DESC, s.symbol`,
  byMint: async (sql: Sql, mint: string) => (await sql<StockRow[]>`
    SELECT s.mint, s.symbol, s.name, s.issuer, s.category, s.decimals, s.logo, s.price_usd, s.change_24h,
           (SELECT count(*)::int FROM tokens t WHERE t.quote_mint = s.mint) AS memes
    FROM stocks s WHERE s.mint = ${mint}`)[0] ?? null,
};
