import postgres from "postgres";
import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import type { Sql } from "../lib/db";

export type DbVars = { sql: Sql; t0: number };

// One client per request, closed after the response is sent. Hyperdrive pools on its side, so max=1, no prepare.
export const withDb: MiddlewareHandler<{ Bindings: Env; Variables: DbVars }> = async (c, next) => {
  const url = c.env.PG?.connectionString ?? c.env.DATABASE_URL;
  if (!url) throw new Error("no database binding");
  const sql = postgres(url, { max: 2, prepare: false, fetch_types: false, idle_timeout: 5 });
  c.set("sql", sql);
  c.set("t0", Date.now());
  try { await next(); } finally {
    c.header("Server-Timing", `app;dur=${Date.now() - c.get("t0")}`);
    c.executionCtx.waitUntil(sql.end({ timeout: 1 }));
  }
};
