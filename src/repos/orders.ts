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
  status: "quoted" | "open" | "filled" | "cancelled" | "failed";
  rent_usd: number | null;
  request_id: string | null;
  msg_hash: string | null;
  signature: string | null;
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
  | "request_id"
  | "msg_hash"
> & { t: number };

export const ordersRepo = {
  insert: (sql: Sql, o: NewOrder) =>
    sql`INSERT INTO orders (id, user_id, wallet, mint, symbol, side, input_mint, output_mint, making_raw,
                            taking_raw, making_usd, trigger_usd, rent_usd, status, request_id, msg_hash, created_at, updated_at)
        VALUES (${o.id}, ${o.user_id}, ${o.wallet}, ${o.mint}, ${o.symbol}, ${o.side}, ${o.input_mint},
                ${o.output_mint}, ${o.making_raw}, ${o.taking_raw}, ${o.making_usd}, ${o.trigger_usd},
                ${o.rent_usd}, 'quoted', ${o.request_id}, ${o.msg_hash}, ${o.t}, ${o.t})
        ON CONFLICT (id) DO NOTHING`,
  byId: (sql: Sql, id: string, userId: string) =>
    sql<OrderRow[]>`SELECT * FROM orders WHERE id = ${id} AND user_id = ${userId}`,
  // A quote is half an order: it only becomes one when the user signs, so the list and the cap ignore them.
  forUser: (sql: Sql, userId: string, limit: number) =>
    sql<OrderRow[]>`SELECT * FROM orders WHERE user_id = ${userId} AND status <> 'quoted'
        ORDER BY created_at DESC LIMIT ${limit}`,
  openFor: (sql: Sql, userId: string) =>
    sql<OrderRow[]>`SELECT * FROM orders WHERE user_id = ${userId} AND status = 'open'`,
  // A cancel is a second transaction to sign, so the row carries its request and hash while it is in flight.
  setPending: (sql: Sql, id: string, requestId: string, msgHash: string, t: number) =>
    sql`UPDATE orders SET request_id = ${requestId}, msg_hash = ${msgHash}, updated_at = ${t} WHERE id = ${id}`,
  markOpen: (sql: Sql, id: string, signature: string, t: number) =>
    sql`UPDATE orders SET status = 'open', signature = ${signature}, updated_at = ${t} WHERE id = ${id}`,
  markFailed: (sql: Sql, id: string, error: string, t: number) =>
    sql`UPDATE orders SET status = 'failed', error = ${error}, updated_at = ${t} WHERE id = ${id}`,
  settle: (sql: Sql, id: string, status: string, fillUsd: number | null, feeUsd: number | null, t: number) =>
    sql`UPDATE orders SET status = ${status}, fill_usd = ${fillUsd}, fee_usd = ${feeUsd},
        filled_at = CASE WHEN ${status} = 'filled' THEN ${t} ELSE filled_at END, updated_at = ${t}
        WHERE id = ${id} AND status <> ${status}`,
};
