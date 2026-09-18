import type { Sql } from "../lib/db";

export type TokenRow = {
  mint: string; symbol: string | null; name: string | null; image: string | null; uri: string | null;
  quote_mint: string; launchpad: string; creator: string | null; decimals: number; supply: string | null;
  phase: "curve" | "graduated"; curve_pool: string | null; amm_pool: string | null; tax_bps: number; created_at: number;
  price_quote: number | null; price_usd: number | null; mcap_usd: number | null; vol_24h_usd: number;
  buys_24h: number; sells_24h: number; change_24h: number | null; progress_pct: number | null; last_trade_at: number | null;
};

const cols = (sql: Sql) => sql`
  t.mint, t.symbol, t.name, t.image, t.uri, t.quote_mint, t.launchpad, t.creator, t.decimals, t.supply::text AS supply,
  t.phase, t.curve_pool, t.amm_pool, t.tax_bps, t.created_at,
  st.price_quote, st.price_usd, st.mcap_usd, coalesce(st.vol_24h_usd,0) AS vol_24h_usd,
  coalesce(st.buys_24h,0) AS buys_24h, coalesce(st.sells_24h,0) AS sells_24h, st.change_24h, st.progress_pct, st.last_trade_at`;

export type Sort = "volume" | "new" | "mcap";

export const tokensRepo = {
  // Keyset pagination: cursor is the sort value + mint of the last row.
  byStock: (sql: Sql, quote: string, sort: Sort, limit: number, after?: { v: number; mint: string }) => {
    const order = sort === "new" ? sql`t.created_at` : sort === "mcap" ? sql`coalesce(st.mcap_usd,0)` : sql`coalesce(st.vol_24h_usd,0)`;
    const where = after
      ? sql`AND (${order}, t.mint) < (${after.v}, ${after.mint})`
      : sql``;
    return sql<TokenRow[]>`
      SELECT ${cols(sql)} FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint
      WHERE t.quote_mint = ${quote} ${where}
      ORDER BY ${order} DESC, t.mint DESC LIMIT ${limit}`;
  },
  byMint: async (sql: Sql, mint: string) => (await sql<TokenRow[]>`
    SELECT ${cols(sql)} FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint WHERE t.mint = ${mint}`)[0] ?? null,
  byMints: (sql: Sql, mints: string[]) => sql<TokenRow[]>`
    SELECT ${cols(sql)} FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint WHERE t.mint = ANY(${mints})`,
};
