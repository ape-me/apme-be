import postgres from "postgres";
import type { Env } from "../env";

// One client per request. Hyperdrive pools on its side, so max=1 and no prepare.
export function db(env: Env) {
  const url = env.PG?.connectionString ?? env.DATABASE_URL;
  if (!url) throw new Error("no database binding");
  return postgres(url, { max: 1, prepare: false, fetch_types: false, idle_timeout: 5 });
}
export type Sql = ReturnType<typeof db>;
