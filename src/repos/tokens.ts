import type { Sql } from "../lib/db";
import type { StockRow } from "./stocks";
import type { TokenFilters } from "../contract";

export type TokenRow = {
  mint: string; symbol: string | null; name: string | null; image: string | null; uri: string | null;
  quote_mint: string; launchpad: string; creator: string | null; decimals: number; supply: string | null;
  phase: "curve" | "graduated"; curve_pool: string | null; amm_pool: string | null; tax_bps: number; created_at: number;
  price_quote: number | null; price_usd: number | null; mcap_usd: number | null; vol_24h_usd: number;
  buys_24h: number; sells_24h: number; change_24h: number | null; progress_pct: number | null; last_trade_at: number | null;
  vol_5m_usd: number; buys_5m: number; sells_5m: number; vol_1h_usd: number; buys_1h: number; sells_1h: number; change_1h: number | null;
  ath_mcap_usd: number | null; holders: number | null; top10_pct: number | null; dev_pct: number | null; snipers_pct: number | null;
  website: string | null; twitter: string | null; telegram: string | null; dex_paid: boolean; dex_paid_at: number | null; dex_boosts: number;
};

const cols = (sql: Sql) => sql`
  t.mint, t.symbol, t.name, t.image, t.uri, t.quote_mint, t.launchpad, t.creator, t.decimals, t.supply::text AS supply,
  t.phase, t.curve_pool, t.amm_pool, t.tax_bps, t.created_at,
  t.website, t.twitter, t.telegram, t.dex_paid, t.dex_paid_at, t.dex_boosts,
  st.price_quote, st.price_usd, st.mcap_usd, coalesce(st.vol_24h_usd,0) AS vol_24h_usd,
  coalesce(st.buys_24h,0) AS buys_24h, coalesce(st.sells_24h,0) AS sells_24h, st.change_24h, st.progress_pct, st.last_trade_at,
  coalesce(st.vol_5m_usd,0) AS vol_5m_usd, coalesce(st.buys_5m,0) AS buys_5m, coalesce(st.sells_5m,0) AS sells_5m,
  coalesce(st.vol_1h_usd,0) AS vol_1h_usd, coalesce(st.buys_1h,0) AS buys_1h, coalesce(st.sells_1h,0) AS sells_1h, st.change_1h,
  st.ath_mcap_usd, st.holders, st.top10_pct, st.dev_pct, st.snipers_pct`;

export type Sort = "volume" | "new" | "mcap" | "vol5m" | "vol1h" | "vol24h" | "txns1h" | "progress" | "change1h" | "change24h";
export type Column = "new" | "graduating" | "graduated";

export const GRADUATING_PCT = 60;
const NEW_WINDOW = 86400;
export const LAUNCHPADS = ["stonkfun", "pumpfun", "dbc"];

// Sort key expression. Every key is non-null so keyset pagination stays total.
const sortExpr = (sql: Sql, sort: Sort) => {
  switch (sort) {
    case "new": return sql`t.created_at`;
    case "mcap": return sql`coalesce(st.mcap_usd,0)`;
    case "vol5m": return sql`coalesce(st.vol_5m_usd,0)`;
    case "vol1h": return sql`coalesce(st.vol_1h_usd,0)`;
    case "txns1h": return sql`(coalesce(st.buys_1h,0) + coalesce(st.sells_1h,0))`;
    case "progress": return sql`coalesce(st.progress_pct,0)`;
    case "change1h": return sql`coalesce(st.change_1h,0)`;
    case "change24h": return sql`coalesce(st.change_24h,0)`;
    default: return sql`coalesce(st.vol_24h_usd,0)`;   // volume, vol24h
  }
};
export const defaultSort = (column?: Column): Sort => (column === "new" ? "new" : column === "graduating" ? "progress" : column === "graduated" ? "vol1h" : "volume");

const columnWhere = (sql: Sql, column: Column | undefined, now: number) => {
  switch (column) {
    case "new": return sql`AND t.phase = 'curve' AND t.created_at > ${now - NEW_WINDOW}`;
    case "graduating": return sql`AND t.phase = 'curve' AND st.progress_pct >= ${GRADUATING_PCT}`;
    case "graduated": return sql`AND t.phase = 'graduated'`;
    default: return sql``;
  }
};

const filterWhere = (sql: Sql, f: TokenFilters, now: number) => {
  const parts = [];
  if (f.minMcap != null) parts.push(sql`AND st.mcap_usd >= ${f.minMcap}`);
  if (f.maxMcap != null) parts.push(sql`AND st.mcap_usd <= ${f.maxMcap}`);
  if (f.minVol1h != null) parts.push(sql`AND st.vol_1h_usd >= ${f.minVol1h}`);
  if (f.minVol24h != null) parts.push(sql`AND st.vol_24h_usd >= ${f.minVol24h}`);
  if (f.minAge != null) parts.push(sql`AND t.created_at <= ${now - f.minAge * 60}`);
  if (f.maxAge != null) parts.push(sql`AND t.created_at >= ${now - f.maxAge * 60}`);
  if (f.minProgress != null) parts.push(sql`AND st.progress_pct >= ${f.minProgress}`);
  if (f.maxProgress != null) parts.push(sql`AND st.progress_pct <= ${f.maxProgress}`);
  if (f.minTxns1h != null) parts.push(sql`AND (coalesce(st.buys_1h,0) + coalesce(st.sells_1h,0)) >= ${f.minTxns1h}`);
  if (f.minBuys24h != null) parts.push(sql`AND st.buys_24h >= ${f.minBuys24h}`);
  if (f.maxTax != null) parts.push(sql`AND t.tax_bps <= ${f.maxTax}`);
  if (f.minHolders != null) parts.push(sql`AND st.holders >= ${f.minHolders}`);
  if (f.maxTop10 != null) parts.push(sql`AND st.top10_pct <= ${f.maxTop10}`);
  if (f.maxDev != null) parts.push(sql`AND st.dev_pct <= ${f.maxDev}`);
  if (f.maxSnipers != null) parts.push(sql`AND st.snipers_pct <= ${f.maxSnipers}`);
  if (f.launchpad) { const l = f.launchpad.split(",").filter((x) => LAUNCHPADS.includes(x)); if (l.length) parts.push(sql`AND t.launchpad IN ${sql(l)}`); }   // array params 500 through Hyperdrive; IN list binds scalars
  if (f.dexPaid === 1) parts.push(sql`AND t.dex_paid`);
  if (f.social === 1) parts.push(sql`AND (t.website IS NOT NULL OR t.twitter IS NOT NULL OR t.telegram IS NOT NULL)`);
  if (f.q) { const q = f.q.trim(); if (q) parts.push(sql`AND (t.symbol ILIKE ${"%" + q + "%"} OR t.name ILIKE ${"%" + q + "%"} OR t.mint LIKE ${q + "%"})`); }
  return parts.reduce((acc, p) => sql`${acc} ${p}`, sql``);
};

export type ListArgs = { stock?: string; column?: Column; sort: Sort; limit: number; after?: { v: number; mint: string }; filters: TokenFilters };

export const tokensRepo = {
  // One list. Keyset pagination on (sort value, mint); `after` comes from the cursor of the previous page.
  list: (sql: Sql, a: ListArgs) => {
    const now = Math.floor(Date.now() / 1000);
    const order = sortExpr(sql, a.sort);
    const stock = a.stock ? sql`AND t.quote_mint = ${a.stock}` : sql``;
    const after = a.after ? sql`AND (${order}, t.mint) < (${a.after.v}, ${a.after.mint})` : sql``;
    return sql<TokenRow[]>`
      SELECT ${cols(sql)}, ${order} AS sort_v FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint
      WHERE t.name IS DISTINCT FROM '' ${stock} ${columnWhere(sql, a.column, now)} ${filterWhere(sql, a.filters, now)} ${after}
      ORDER BY ${order} DESC, t.mint DESC LIMIT ${a.limit}`;
  },
  byMints: (sql: Sql, mints: string[]) => sql<TokenRow[]>`
    SELECT ${cols(sql)} FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint WHERE t.mint IN ${sql(mints)}`,
  byMint: async (sql: Sql, mint: string) => (await sql<TokenRow[]>`
    SELECT ${cols(sql)} FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint WHERE t.mint = ${mint}`)[0] ?? null,
  // Token joined with its quote stock: one round trip for the token page header and the trades tape.
  withStock: async (sql: Sql, mint: string) => (await sql<(TokenRow & { stock: StockRow })[]>`
    SELECT ${cols(sql)}, row_to_json(s) AS stock
    FROM tokens t LEFT JOIN token_stats st ON st.token_mint = t.mint JOIN stocks s ON s.mint = t.quote_mint
    WHERE t.mint = ${mint}`)[0] ?? null,
};
