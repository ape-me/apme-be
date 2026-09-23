// Runs on the prod box (Bun in Docker), not in the Worker: a limit order fills on chain with nobody watching,
// so something has to ask Jupiter. Settles our rows, writes each fill as a swap, and pushes the result to the
// user's private room so the phone hears about it without opening the Orders tab.
import postgres from "postgres";
import { reconcile } from "../src/services/orders";
import { ordersRepo } from "../src/repos/orders";
import { sign } from "../src/lib/hmac";
import type { Env } from "../src/env";

const env = process.env as unknown as Env;
const sql = postgres(process.env.DATABASE_URL!, { max: 4, prepare: false, idle_timeout: 5 });

const open = await ordersRepo.allOpen(sql, 500);
const settled = await reconcile(env, sql, open);

if (settled.length && env.INGEST_URL && env.INGEST_SECRET) {
  const body = JSON.stringify({
    sentAt: Math.floor(Date.now() / 1000),
    orders: settled.map(({ row, status, fillUsd }) => ({
      userId: row.user_id,
      id: row.id,
      mint: row.mint,
      symbol: row.symbol,
      side: row.side,
      status,
      fillUsd,
      signature: row.signature,
    })),
  });
  const r = await fetch(`${env.INGEST_URL}/trades`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-signature": await sign(env.INGEST_SECRET, body) },
    body,
  });
  if (!r.ok) console.error("publish failed", r.status, (await r.text()).slice(0, 200));
}

console.log(new Date().toISOString(), JSON.stringify({ open: open.length, settled: settled.length }));
await sql.end({ timeout: 2 });
