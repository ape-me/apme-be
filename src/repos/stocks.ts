import type { Sql } from "../lib/db";

export type StockConfig = { excluded: boolean; category: string | null; tags: string[] | string; note: string | null };
export type StockRow = {
  mint: string; symbol: string; name: string; issuer: string; category: string; decimals: number;
  logo: string | null; price_usd: number | null; change_24h: number | null; memes?: number; multiplier: number; tags: string[] | string;
  mark_usd: number | null; premium_pct: number | null; liquidity_usd: number | null;
  vol_24h_usd: number | null; buys_24h: number | null; sells_24h: number | null;
  heat: number; launched_24h: number; meme_vol_24h: number; wallets_24h: number;
  king_mint: string | null; king_symbol: string | null; king_image: string | null; king_vol: number | null;
  king_price: number | null; king_mcap: number | null; king_change: number | null; king_phase: "curve" | "graduated" | null; king_progress: number | null; king_launchpad: string | null;
};

// One row per stock: its market data plus its floor's last 24h (stock_stats, refreshed by the indexer).
const select = (sql: Sql, where: ReturnType<Sql>) => sql<StockRow[]>`
  SELECT s.mint, s.symbol, s.name, s.issuer, s.category, s.decimals, s.logo, s.price_usd, s.change_24h, s.multiplier, s.tags,
         s.mark_usd, s.premium_pct, s.liquidity_usd, s.vol_24h_usd, s.buys_24h, s.sells_24h,
         (SELECT count(*)::int FROM tokens k WHERE k.quote_mint = s.mint) AS memes,
         coalesce(ss.launched_24h, 0) AS launched_24h, coalesce(ss.meme_vol_24h, 0) AS meme_vol_24h,
         coalesce(ss.wallets_24h, 0) AS wallets_24h, coalesce(ss.heat, 0) AS heat,
         ss.king_mint, kg.symbol AS king_symbol, kg.image AS king_image, kst.vol_24h_usd AS king_vol,
         kst.price_usd AS king_price, kst.mcap_usd AS king_mcap, kst.change_24h AS king_change, kg.phase AS king_phase, kst.progress_pct AS king_progress, kg.launchpad AS king_launchpad
  FROM stocks s
  LEFT JOIN stock_stats ss ON ss.mint = s.mint
  LEFT JOIN tokens kg ON kg.mint = ss.king_mint
  LEFT JOIN token_stats kst ON kst.token_mint = ss.king_mint
  WHERE s.category <> 'crypto' AND NOT s.excluded ${where}
  ORDER BY heat DESC, memes DESC, s.symbol`;

export const stocksRepo = {
  all: (sql: Sql) => select(sql, sql``),
  byMint: async (sql: Sql, mint: string) => (await select(sql, sql`AND s.mint = ${mint}`))[0] ?? null,
  byMints: (sql: Sql, mints: string[]) => select(sql, sql`AND s.mint IN ${sql(mints)}`),
  withConfig: (sql: Sql) => sql`SELECT s.mint, s.symbol, s.issuer, s.category, s.excluded, s.tags, c.note, c.updated_at
                                FROM stocks s LEFT JOIN stock_config c ON c.mint = s.mint ORDER BY s.excluded DESC, s.symbol`,
  config: async (sql: Sql, mint: string) => (await sql<StockConfig[]>`SELECT excluded, category, tags, note FROM stock_config WHERE mint = ${mint}`)[0] ?? null,
  // Tags travel as csv and split in SQL: array params 500 through Hyperdrive.
  upsertConfig: (sql: Sql, mint: string, c: StockConfig, csv: string, now: number) =>
    sql`INSERT INTO stock_config (mint, excluded, category, tags, note, updated_at) VALUES (${mint}, ${c.excluded}, ${c.category}, COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), ${c.note}, ${now})
        ON CONFLICT (mint) DO UPDATE SET excluded = ${c.excluded}, category = ${c.category}, tags = COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), note = ${c.note}, updated_at = ${now}`,
  applyConfig: async (sql: Sql, mint: string, c: StockConfig, csv: string) =>
    (await sql`UPDATE stocks SET excluded = ${c.excluded}, tags = COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), category = COALESCE(${c.category}, category) WHERE mint = ${mint} RETURNING mint, symbol, category, excluded, tags`)[0] ?? null,
};
