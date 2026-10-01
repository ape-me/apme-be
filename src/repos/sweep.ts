import type { Sql } from "../lib/db";

export const sweepRepo = {
  owed: async (sql: Sql, wallet: string) =>
    BigInt(
      (await sql<{ lamports: string }[]>`SELECT lamports FROM sol_owed WHERE wallet = ${wallet}`)[0]
        ?.lamports ?? 0,
    ),
  add: (sql: Sql, wallet: string, lamports: bigint, t: number) =>
    sql`INSERT INTO sol_owed (wallet, lamports, updated_at) VALUES (${wallet}, ${lamports.toString()}, ${t})
        ON CONFLICT (wallet) DO UPDATE SET lamports = sol_owed.lamports + EXCLUDED.lamports, updated_at = ${t}`,
  take: (sql: Sql, wallet: string, lamports: bigint, t: number) =>
    sql`UPDATE sol_owed SET lamports = GREATEST(lamports - ${lamports.toString()}, 0), updated_at = ${t} WHERE wallet = ${wallet}`,
};
