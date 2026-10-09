import type { Sql } from "../lib/db";

// A listing with no price or no pool left is dead: it cannot be traded, so it never reaches a card.
const MIN_LIQUIDITY_USD = 5_000;

export type StockConfig = {
  excluded: boolean;
  category: string | null;
  tags: string[] | string;
  note: string | null;
};
export type StockRow = {
  mint: string;
  symbol: string;
  name: string;
  issuer: string;
  category: string;
  decimals: number;
  logo: string | null;
  price_usd: number | null;
  change_24h: number | null;
  multiplier: number;
  tags: string[] | string;
  mark_usd: number | null;
  premium_pct: number | null;
  liquidity_usd: number | null;
  vol_24h_usd: number | null;
  buys_24h: number | null;
  sells_24h: number | null;
  halted: boolean;
  underlying: string | null;
  mark_valuation: number | null;
  supply: number | null;
};

export const Category = ["stock", "etf", "preipo", "crypto", "earn"] as const;
export type Category = (typeof Category)[number];
const COLS = (sql: Sql) => sql`
  s.mint, s.symbol, s.name, s.issuer, s.category, s.decimals, s.logo, s.price_usd, s.change_24h, s.multiplier, s.tags,
  s.mark_usd, s.premium_pct, s.liquidity_usd, s.vol_24h_usd, s.buys_24h, s.sells_24h, s.halted, s.underlying,
  s.mark_valuation, s.supply`;
// Only what can be traded reaches a card: priced, pooled, not excluded. Ondo fills through Jupiter's RFQ, so
// its pool depth says nothing about whether it trades.
const live = (sql: Sql) =>
  sql`NOT s.excluded AND s.price_usd IS NOT NULL AND (coalesce(s.liquidity_usd, 0) >= ${MIN_LIQUIDITY_USD} OR s.issuer = 'ondo')`;
const order = (sql: Sql) =>
  sql`ORDER BY coalesce(s.vol_24h_usd, 0) DESC, coalesce(s.liquidity_usd, 0) DESC, s.symbol`;
// Specific mints, e.g. a holding or an order: whichever issuer's token it is.
const select = (sql: Sql, where: ReturnType<Sql>) => sql<StockRow[]>`
  SELECT ${COLS(sql)} FROM stocks s WHERE ${live(sql)} ${where} ${order(sql)}`;
// The list: one row per company, the deepest pool wins when two issuers tokenize the same stock.
// Stocks, ETFs and pre-IPO share the default tab; crypto and earn only appear when asked for.
const list = (sql: Sql, category?: Category) => sql<StockRow[]>`
  SELECT * FROM (
    SELECT DISTINCT ON (coalesce(s.underlying, s.mint)) ${COLS(sql)}
    FROM stocks s WHERE ${live(sql)}
      AND ${category ? sql`s.category = ${category}` : sql`s.category NOT IN ('crypto', 'earn')`}
    ORDER BY coalesce(s.underlying, s.mint), coalesce(s.liquidity_usd, 0) DESC) s
  ${order(sql)}`;

export const stocksRepo = {
  all: (sql: Sql, category?: Category) => list(sql, category),
  byMint: async (sql: Sql, mint: string) => (await select(sql, sql`AND s.mint = ${mint}`))[0] ?? null,
  byMints: (sql: Sql, mints: string[]) => select(sql, sql`AND s.mint IN ${sql(mints)}`),
  // Last price at each of the 25 hour marks back from `t` (24h ago first), one index probe each; null before the first snapshot.
  hourly: (sql: Sql, mints: string[], t: number) => sql<{ mint: string; points: (number | null)[] }[]>`
    SELECT m.mint, array_agg(p.price_usd ORDER BY h.i) AS points
    FROM (SELECT mint FROM stocks WHERE mint IN ${sql(mints)}) m
    CROSS JOIN generate_series(0, 24) h(i)
    LEFT JOIN LATERAL (
      SELECT price_usd FROM stock_snapshots s
      WHERE s.mint = m.mint AND s.ts <= ${t} - (24 - h.i) * 3600 AND s.ts > ${t - 25 * 3600} AND s.price_usd IS NOT NULL
      ORDER BY s.ts DESC LIMIT 1) p ON true
    GROUP BY m.mint`,
  withConfig: (
    sql: Sql,
  ) => sql`SELECT s.mint, s.symbol, s.issuer, s.category, s.excluded, s.tags, c.note, c.updated_at
                                FROM stocks s LEFT JOIN stock_config c ON c.mint = s.mint ORDER BY s.excluded DESC, s.symbol`,
  config: async (sql: Sql, mint: string) =>
    (
      await sql<StockConfig[]>`SELECT excluded, category, tags, note FROM stock_config WHERE mint = ${mint}`
    )[0] ?? null,
  // Tags travel as csv and split in SQL: array params 500 through Hyperdrive.
  upsertConfig: (sql: Sql, mint: string, c: StockConfig, csv: string, now: number) =>
    sql`INSERT INTO stock_config (mint, excluded, category, tags, note, updated_at) VALUES (${mint}, ${c.excluded}, ${c.category}, COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), ${c.note}, ${now})
        ON CONFLICT (mint) DO UPDATE SET excluded = ${c.excluded}, category = ${c.category}, tags = COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), note = ${c.note}, updated_at = ${now}`,
  applyConfig: async (sql: Sql, mint: string, c: StockConfig, csv: string) =>
    (
      await sql`UPDATE stocks SET excluded = ${c.excluded}, tags = COALESCE(string_to_array(NULLIF(${csv}, ''), ','), '{}'), category = COALESCE(${c.category}, category) WHERE mint = ${mint} RETURNING mint, symbol, category, excluded, tags`
    )[0] ?? null,
};
