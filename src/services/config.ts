import type { Sql } from "../lib/db";
import { configRepo } from "../repos/config";

// Operator knobs, read per isolate with a short cache so a change lands within a minute without a deploy.
const TTL_MS = 60_000;
const cache = new Map<string, { v: string; at: number }>();

export async function configNum(sql: Sql, key: string, fallback: number) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return Number(hit.v);
  const [row] = await configRepo.get(sql, key);
  if (!row) return fallback;
  cache.set(key, { v: row.value, at: Date.now() });
  const n = Number(row.value);
  return Number.isFinite(n) ? n : fallback;
}

export async function setConfig(sql: Sql, key: string, value: string) {
  await configRepo.set(sql, key, value, Math.floor(Date.now() / 1000));
  cache.set(key, { v: value, at: Date.now() });
  return { key, value };
}

export const listConfig = (sql: Sql) => configRepo.all(sql);
