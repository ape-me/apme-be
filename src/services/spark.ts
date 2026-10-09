import type { Sql } from "../lib/db";
import { stocksRepo } from "../repos/stocks";

export type Spark = { spark: number[] | null; prevClose: number | null };
const NONE: Spark = { spark: null, prevClose: null };
const TTL_S = 60;

// Per-isolate memo: list rows share mints across endpoints and don't need to be live.
const memo = new Map<string, { at: number; s: Spark }>();

// 24 hourly closes (oldest first) plus the price 24h ago, per mint. Null until a stock has a full day of history.
export async function sparks(sql: Sql, mints: string[]): Promise<Map<string, Spark>> {
  const t = Math.floor(Date.now() / 1000);
  const stale = [...new Set(mints)].filter((m) => (memo.get(m)?.at ?? 0) <= t - TTL_S);
  if (stale.length) {
    const got = new Map(
      (await stocksRepo.hourly(sql, stale, t)).map((r) => [
        r.mint,
        r.points.split(",").map((x) => (x === "" ? null : Number(x))),
      ]),
    );
    for (const m of stale) {
      const p = got.get(m);
      const spark = p && p[1] != null ? (p.slice(1) as number[]) : null;
      memo.set(m, { at: t, s: { spark, prevClose: p?.[0] ?? null } });
    }
  }
  return new Map(mints.map((m) => [m, memo.get(m)?.s ?? NONE]));
}
