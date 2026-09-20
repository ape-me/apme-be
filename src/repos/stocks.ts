import type { Sql } from "../lib/db";

export type StockRow = {
  mint: string; symbol: string; name: string; issuer: string; category: string; decimals: number;
  logo: string | null; price_usd: number | null; change_24h: number | null; memes?: number; multiplier: number;
  mark_usd: number | null; premium_pct: number | null; liquidity_usd: number | null;
  vol_24h_usd: number | null; buys_24h: number | null; sells_24h: number | null;
  heat: number; launched_24h: number; meme_vol_24h: number; wallets_24h: number;
  king_mint: string | null; king_symbol: string | null; king_image: string | null; king_vol: number | null;
};

// One row per stock with its own market data plus what its floor did in the last 24h.
// heat ranks floors: launches count most, then people, then dollars. `crypto` pairs are never stocks.
// One row per stock: its own market data (stocks) plus what its floor did in the last 24h (stock_stats,
// refreshed every 60s by the indexer). `crypto` pairs are never stocks.
const select = (sql: Sql, where: ReturnType<Sql>) => sql<StockRow[]>`
  SELECT s.mint, s.symbol, s.name, s.issuer, s.category, s.decimals, s.logo, s.price_usd, s.change_24h, s.multiplier,
         s.mark_usd, s.premium_pct, s.liquidity_usd, s.vol_24h_usd, s.buys_24h, s.sells_24h,
         (SELECT count(*)::int FROM tokens k WHERE k.quote_mint = s.mint) AS memes,
         coalesce(ss.launched_24h, 0) AS launched_24h, coalesce(ss.meme_vol_24h, 0) AS meme_vol_24h,
         coalesce(ss.wallets_24h, 0) AS wallets_24h, coalesce(ss.heat, 0) AS heat,
         ss.king_mint, kg.symbol AS king_symbol, kg.image AS king_image, kst.vol_24h_usd AS king_vol
  FROM stocks s
  LEFT JOIN stock_stats ss ON ss.mint = s.mint
  LEFT JOIN tokens kg ON kg.mint = ss.king_mint
  LEFT JOIN token_stats kst ON kst.token_mint = ss.king_mint
  WHERE s.category <> 'crypto' ${where}
  ORDER BY heat DESC, memes DESC, s.symbol`;

export const stocksRepo = {
  all: (sql: Sql) => select(sql, sql``),
  byMint: async (sql: Sql, mint: string) => (await select(sql, sql`AND s.mint = ${mint}`))[0] ?? null,
};
