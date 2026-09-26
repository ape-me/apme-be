import type { Sql } from "../lib/db";

export type KnownRow = {
  mint: string;
  kind: "stock";
  symbol: string | null;
  name: string | null;
  image: string | null;
  decimals: number;
  price_usd: number | null;
  change_24h: number | null;
  quote_symbol: string | null;
  multiplier: number;
};

type Page = {
  wallet: string;
  sides: string[];
  mint: string | null;
  from: number | null;
  to: number | null;
  before: number | null;
  limit: number;
};

type SwapPositionRow = {
  mint: string;
  bought_raw: string;
  sold_raw: string;
  bought_usd: number;
  sold_usd: number;
  fees_usd: number;
};
export type SwapActivityRow = {
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
    SELECT mint, coalesce(sum(b_raw),0)::text AS bought_raw, coalesce(sum(s_raw),0)::text AS sold_raw, coalesce(sum(b_usd),0) AS bought_usd, coalesce(sum(s_usd),0) AS sold_usd, coalesce(sum(fees),0) AS fees_usd FROM (
      SELECT output_mint AS mint, out_raw AS b_raw, 0 AS s_raw, coalesce(swap_usd, in_usd) AS b_usd, 0 AS s_usd, coalesce(fee_usd,0) + coalesce(rent_usd,0) + coalesce(issuer_fee_usd,0) AS fees FROM swaps WHERE wallet = ${wallet} AND status = 'confirmed' AND side = 'buy'
      UNION ALL
      SELECT input_mint, 0, in_raw, 0, out_usd, coalesce(fee_usd,0) + coalesce(issuer_fee_usd,0) FROM swaps WHERE wallet = ${wallet} AND status = 'confirmed' AND side = 'sell') x GROUP BY mint`,
  swapActivity: (sql: Sql, wallet: string, limit: number) => sql<SwapActivityRow[]>`
    SELECT id, signature, side, status, error, created_at, confirmed_at, input_mint, output_mint, in_raw::text AS in_raw, out_raw::text AS out_raw, in_usd, out_usd, fee_usd, symbol
    FROM swaps WHERE wallet = ${wallet} AND status <> 'quoted' ORDER BY created_at DESC LIMIT ${limit}`,
  saveDeposits: (
    sql: Sql,
    wallet: string,
    ds: { sig: string; ts: number; amount: number; from: string | null; direction: "in" | "out" }[],
  ) =>
    sql`INSERT INTO deposits ${sql(
      ds.map((d) => ({
        signature: d.sig,
        wallet,
        ts: d.ts,
        direction: d.direction,
        amount: d.amount,
        from_addr: d.from,
      })),
    )} ON CONFLICT (signature) DO NOTHING`,
  // One page of history. Each source is asked for the same window so the caller can merge and cut cleanly.
  swapPage: (sql: Sql, a: Page) => sql<SwapActivityRow[]>`
    SELECT id, signature, side, status, error, created_at, confirmed_at, input_mint, output_mint,
           in_raw::text AS in_raw, out_raw::text AS out_raw, in_usd, out_usd, fee_usd, symbol
    FROM swaps WHERE wallet = ${a.wallet} AND status <> 'quoted'
      ${a.sides.length ? sql`AND side IN ${sql(a.sides)}` : sql``}
      ${a.mint ? sql`AND (input_mint = ${a.mint} OR output_mint = ${a.mint})` : sql``}
      ${a.from ? sql`AND coalesce(confirmed_at, created_at) >= ${a.from}` : sql``}
      ${a.to ? sql`AND coalesce(confirmed_at, created_at) <= ${a.to}` : sql``}
      ${a.before ? sql`AND coalesce(confirmed_at, created_at) <= ${a.before}` : sql``}
    ORDER BY coalesce(confirmed_at, created_at) DESC LIMIT ${a.limit}`,
  depositPage: (sql: Sql, a: Page & { directions: string[] }) => sql<
    { signature: string; ts: number; direction: "in" | "out"; amount: number; from_addr: string | null }[]
  >`
    SELECT signature, ts, direction, amount, from_addr FROM deposits
    WHERE wallet = ${a.wallet} AND direction IN ${sql(a.directions)}
      ${a.from ? sql`AND ts >= ${a.from}` : sql``}
      ${a.to ? sql`AND ts <= ${a.to}` : sql``}
      ${a.before ? sql`AND ts <= ${a.before}` : sql``}
    ORDER BY ts DESC LIMIT ${a.limit}`,
  // Everything we can price among a wallet's mints, in one round trip.
  known: (sql: Sql, mints: string[]) => sql<KnownRow[]>`
    SELECT s.mint, 'stock' AS kind, s.symbol, s.name, s.logo AS image, s.decimals, s.price_usd, s.change_24h, NULL AS quote_symbol, s.multiplier
    FROM stocks s WHERE s.mint IN ${sql(mints)}`,
};
