import type { Sql } from "../lib/db";

export type ConfigRow = { key: string; value: string; updated_at: number };

export const configRepo = {
  all: (sql: Sql) => sql<ConfigRow[]>`SELECT * FROM app_config ORDER BY key`,
  get: (sql: Sql, key: string) => sql<ConfigRow[]>`SELECT * FROM app_config WHERE key = ${key}`,
  set: (sql: Sql, key: string, value: string, t: number) =>
    sql`INSERT INTO app_config (key, value, updated_at) VALUES (${key}, ${value}, ${t})
        ON CONFLICT (key) DO UPDATE SET value = ${value}, updated_at = ${t}`,
};
