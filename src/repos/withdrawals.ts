import type { Sql } from "../lib/db";

export type WithdrawalRow = {
  id: string;
  user_id: string;
  wallet: string;
  to_address: string;
  mint: string;
  symbol: string | null;
  amount_raw: string;
  decimals: number;
  usd: number | null;
  rent_lamports: string;
  msg_hash: string;
  signature: string | null;
  status: string;
  error: string | null;
  created_at: string;
  submitted_at: string | null;
  confirmed_at: string | null;
};

export const withdrawalsRepo = {
  insert: (
    sql: Sql,
    w: {
      id: string;
      userId: string;
      wallet: string;
      to: string;
      mint: string;
      symbol: string | null;
      amountRaw: string;
      decimals: number;
      usd: number | null;
      rentLamports: number;
      msgHash: string;
      t: number;
    },
  ) => sql`INSERT INTO withdrawals (id, user_id, wallet, to_address, mint, symbol, amount_raw, decimals, usd, rent_lamports, msg_hash, status, created_at)
           VALUES (${w.id}, ${w.userId}, ${w.wallet}, ${w.to}, ${w.mint}, ${w.symbol}, ${w.amountRaw}, ${w.decimals}, ${w.usd}, ${w.rentLamports}, ${w.msgHash}, 'quoted', ${w.t})`,
  byId: (sql: Sql, id: string, userId: string) =>
    sql<WithdrawalRow[]>`SELECT * FROM withdrawals WHERE id = ${id} AND user_id = ${userId}`,
  sentLastHour: (sql: Sql, userId: string, since: number) =>
    sql<
      { n: number }[]
    >`SELECT COUNT(*)::int AS n FROM withdrawals WHERE user_id = ${userId} AND status <> 'quoted' AND created_at > ${since}`,
  markSubmitted: (sql: Sql, id: string, sig: string, t: number) =>
    sql`UPDATE withdrawals SET status = 'submitted', signature = ${sig}, submitted_at = ${t} WHERE id = ${id} AND status = 'quoted'`,
  markConfirmed: (sql: Sql, id: string, t: number) =>
    sql`UPDATE withdrawals SET status = 'confirmed', confirmed_at = ${t} WHERE id = ${id} AND status = 'submitted'`,
  markFailed: (sql: Sql, id: string, error: string) =>
    sql`UPDATE withdrawals SET status = 'failed', error = ${error} WHERE id = ${id} AND status IN ('quoted','submitted')`,
};
