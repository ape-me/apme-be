import type { Sql } from "../lib/db";

type SwapRow = {
  id: string;
  user_id: string;
  wallet: string;
  side: string;
  input_mint: string;
  output_mint: string;
  symbol: string | null;
  in_raw: string;
  out_raw: string | null;
  min_out_raw: string | null;
  in_usd: number | null;
  out_usd: number | null;
  fee_bps: number;
  fee_raw: string | null;
  fee_usd: number | null;
  price_impact_pct: number | null;
  premium_pct: number | null;
  priority: string;
  gas_lamports: string;
  rent_lamports: string;
  signature: string | null;
  slot: string | null;
  status: string;
  error: string | null;
  msg_hash: string | null;
  signed_tx: string | null;
  last_valid_block_height: string | null;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
};

export const swapsRepo = {
  insertQuote: (
    sql: Sql,
    s: {
      id: string;
      userId: string;
      wallet: string;
      side: string;
      inputMint: string;
      outputMint: string;
      symbol: string | null;
      inRaw: string;
      outRaw: string;
      minOutRaw: string;
      inUsd: number;
      outUsd: number;
      feeBps: number;
      feeRaw: string;
      feeUsd: number;
      priceImpactPct: number;
      premiumPct: number | null;
      priority: string;
      gasLamports: number;
      rentLamports: number;
      swapUsd: number;
      rentUsd: number;
      issuerFeeUsd: number;
      msgHash: string;
      lastValidBlockHeight: number;
      t: number;
    },
  ) => sql`INSERT INTO swaps (id, user_id, wallet, side, input_mint, output_mint, symbol, in_raw, out_raw, min_out_raw, in_usd, out_usd, fee_bps, fee_raw, fee_usd,
                               price_impact_pct, premium_pct, priority, gas_lamports, rent_lamports, swap_usd, rent_usd, issuer_fee_usd, msg_hash, last_valid_block_height, status, created_at)
           VALUES (${s.id}, ${s.userId}, ${s.wallet}, ${s.side}, ${s.inputMint}, ${s.outputMint}, ${s.symbol}, ${s.inRaw}, ${s.outRaw}, ${s.minOutRaw}, ${s.inUsd}, ${s.outUsd},
                   ${s.feeBps}, ${s.feeRaw}, ${s.feeUsd}, ${s.priceImpactPct}, ${s.premiumPct}, ${s.priority}, ${s.gasLamports}, ${s.rentLamports}, ${s.swapUsd}, ${s.rentUsd}, ${s.issuerFeeUsd}, ${s.msgHash}, ${s.lastValidBlockHeight}, 'quoted', ${s.t})`,
  // A limit order that filled is a trade like any other: activity, cost basis and positions all read swaps.
  insertFill: (
    sql: Sql,
    s: {
      id: string;
      userId: string;
      wallet: string;
      side: "buy" | "sell";
      inputMint: string;
      outputMint: string;
      symbol: string | null;
      inRaw: string;
      outRaw: string;
      inUsd: number;
      outUsd: number;
      feeUsd: number;
      signature: string | null;
      t: number;
    },
  ) => sql`INSERT INTO swaps (id, user_id, wallet, side, input_mint, output_mint, symbol, in_raw, out_raw,
                              in_usd, out_usd, fee_usd, swap_usd, signature, status, created_at, confirmed_at)
           VALUES (${s.id}, ${s.userId}, ${s.wallet}, ${s.side}, ${s.inputMint}, ${s.outputMint}, ${s.symbol},
                   ${s.inRaw}, ${s.outRaw}, ${s.inUsd}, ${s.outUsd}, ${s.feeUsd}, ${s.inUsd}, ${s.signature},
                   'confirmed', ${s.t}, ${s.t})
           ON CONFLICT (id) DO NOTHING`,
  byId: (sql: Sql, id: string, userId: string) =>
    sql<SwapRow[]>`SELECT * FROM swaps WHERE id = ${id} AND user_id = ${userId}`,
  bySignature: (sql: Sql, sig: string) => sql<SwapRow[]>`SELECT * FROM swaps WHERE signature = ${sig}`,
  markSubmitted: (sql: Sql, id: string, sig: string, signedTx: string, t: number) =>
    sql`UPDATE swaps SET status = 'submitted', signature = ${sig}, signed_tx = ${signedTx}, submitted_at = ${t} WHERE id = ${id} AND status = 'quoted'`,
  markConfirmed: (sql: Sql, id: string, slot: number, t: number) =>
    sql<
      SwapRow[]
    >`UPDATE swaps SET status = 'confirmed', slot = ${slot}, confirmed_at = ${t} WHERE id = ${id} AND status = 'submitted' RETURNING *`,
  markFailed: (sql: Sql, id: string, error: string) =>
    sql`UPDATE swaps SET status = 'failed', error = ${error} WHERE id = ${id} AND status IN ('quoted','submitted')`,
  sponsoredLastHour: (sql: Sql, userId: string, since: number) =>
    sql<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM swaps WHERE user_id = ${userId} AND status <> 'quoted' AND created_at > ${since}`,
  recordRent: (sql: Sql, userId: string, mint: string, lamports: number, t: number) =>
    sql`INSERT INTO sponsored_rent (user_id, mint, lamports, paid_at) VALUES (${userId}, ${mint}, ${lamports}, ${t}) ON CONFLICT DO NOTHING`,
  // Referrer's cut of our fee, once per confirmed swap (swap_id is unique).
  accrueReferral: (
    sql: Sql,
    id: string,
    referrerId: string,
    refereeId: string,
    swapId: string,
    amountUsd: number,
    t: number,
  ) =>
    sql`INSERT INTO referral_earnings (id, referrer_user_id, referee_user_id, swap_id, amount_usd, created_at) VALUES (${id}, ${referrerId}, ${refereeId}, ${swapId}, ${amountUsd}, ${t}) ON CONFLICT (swap_id) DO NOTHING`,
  referrerOf: (sql: Sql, userId: string) =>
    sql<
      { referrer_user_id: string }[]
    >`SELECT referrer_user_id FROM referrals WHERE referee_user_id = ${userId}`,
  stockMeta: (sql: Sql, mint: string) => sql<
    {
      symbol: string;
      decimals: number;
      premium_pct: number | null;
      mark_usd: number | null;
      price_usd: number | null;
      multiplier: number;
      issuer: string;
    }[]
  >`
    SELECT symbol, decimals, premium_pct, mark_usd, price_usd, multiplier, issuer FROM stocks WHERE mint = ${mint}`,
  tokenMeta: (sql: Sql, mint: string) =>
    sql<
      { symbol: string | null; decimals: number }[]
    >`SELECT symbol, decimals FROM tokens WHERE mint = ${mint}`,
};
