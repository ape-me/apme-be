import type { Sql } from "../lib/db";

export type OrderRow = {
  id: string;
  user_id: string;
  wallet: string;
  mint: string;
  symbol: string | null;
  side: "buy" | "sell";
  input_mint: string;
  output_mint: string;
  making_raw: string;
  taking_raw: string;
  making_usd: number | null;
  trigger_usd: number | null;
  status: "quoted" | "open" | "expired" | "filled" | "cancelled" | "failed";
  rent_usd: number | null;
  request_id: string | null;
  msg_hash: string | null;
  signature: string | null;
  cancel_signature: string | null;
  decimals: number | null;
  multiplier: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
  filled_at: number | null;
  fill_usd: number | null;
  fee_usd: number | null;
  error: string | null;
};

export type NewOrder = Pick<
  OrderRow,
  | "id"
  | "user_id"
  | "wallet"
  | "mint"
  | "symbol"
  | "side"
  | "input_mint"
  | "output_mint"
  | "making_raw"
  | "taking_raw"
  | "making_usd"
  | "trigger_usd"
  | "rent_usd"
  | "expires_at"
  | "request_id"
  | "msg_hash"
> & { t: number };

export const ordersRepo = {
  insert: (sql: Sql, o: NewOrder) =>
    sql`INSERT INTO orders (id, user_id, wallet, mint, symbol, side, input_mint, output_mint, making_raw,
                            taking_raw, making_usd, trigger_usd, rent_usd, expires_at, status, request_id, msg_hash, created_at, updated_at)
        VALUES (${o.id}, ${o.user_id}, ${o.wallet}, ${o.mint}, ${o.symbol}, ${o.side}, ${o.input_mint},
                ${o.output_mint}, ${o.making_raw}, ${o.taking_raw}, ${o.making_usd}, ${o.trigger_usd},
                ${o.rent_usd}, ${o.expires_at}, 'quoted', ${o.request_id}, ${o.msg_hash}, ${o.t}, ${o.t})
        ON CONFLICT (id) DO NOTHING`,
  byId: (sql: Sql, id: string, userId: string) =>
    sql<OrderRow[]>`SELECT * FROM orders WHERE id = ${id} AND user_id = ${userId}`,
  // A quote is half an order: it only becomes one when the user signs, so the list and the cap ignore them.
  // The stonk's decimals and rebase multiplier ride along so a raw amount can be shown as a share count.
  forUser: (sql: Sql, userId: string, limit: number) =>
    sql<OrderRow[]>`SELECT o.*, s.decimals, s.multiplier FROM orders o LEFT JOIN stocks s ON s.mint = o.mint
        WHERE o.user_id = ${userId} AND o.status <> 'quoted'
        ORDER BY o.created_at DESC LIMIT ${limit}`,
  // A second order on the same stonk must not pay again for the token account the first one opened. Only a
  // live order counts: a quote nobody signed never opened anything.
  openForMint: (sql: Sql, userId: string, mint: string) =>
    sql<{ id: string }[]>`SELECT id FROM orders WHERE user_id = ${userId} AND mint = ${mint}
        AND status = 'open'`,
  // Every live order, for the reconcile pass that runs without a phone asking.
  allOpen: (sql: Sql, limit: number) =>
    sql<
      OrderRow[]
    >`SELECT * FROM orders WHERE status IN ('open', 'expired') ORDER BY created_at LIMIT ${limit}`,
  openFor: (sql: Sql, userId: string) =>
    sql<OrderRow[]>`SELECT * FROM orders WHERE user_id = ${userId} AND status IN ('open', 'expired')`,
  // A cancel is a second transaction to sign, so the row carries its request and hash while it is in flight.
  setPending: (sql: Sql, id: string, requestId: string, msgHash: string, t: number) =>
    sql`UPDATE orders SET request_id = ${requestId}, msg_hash = ${msgHash}, updated_at = ${t} WHERE id = ${id}`,
  markOpen: (sql: Sql, id: string, signature: string, t: number) =>
    sql`UPDATE orders SET status = 'open', signature = ${signature}, updated_at = ${t} WHERE id = ${id}`,
  // Jupiter leaves an expired order holding the maker's funds, so it is its own state: done working, not done.
  markExpired: (sql: Sql, id: string, t: number) =>
    sql`UPDATE orders SET status = 'expired', updated_at = ${t} WHERE id = ${id} AND status = 'open'`,
  markCancelled: (sql: Sql, id: string, signature: string, t: number) =>
    sql`UPDATE orders SET status = 'cancelled', cancel_signature = ${signature}, updated_at = ${t} WHERE id = ${id}`,
  markFailed: (sql: Sql, id: string, error: string, t: number) =>
    sql`UPDATE orders SET status = 'failed', error = ${error}, updated_at = ${t} WHERE id = ${id}`,
  settle: (sql: Sql, id: string, status: string, fillUsd: number | null, feeUsd: number | null, t: number) =>
    sql`UPDATE orders SET status = ${status}, fill_usd = ${fillUsd}, fee_usd = ${feeUsd},
        filled_at = CASE WHEN ${status} = 'filled' THEN ${t} ELSE filled_at END, updated_at = ${t}
        WHERE id = ${id} AND status <> ${status}`,
};
