import postgres from "postgres";

export type Sql = ReturnType<typeof postgres>;

// Short-lived client for cron work; request handlers use the withDb middleware instead.
export const openDb = (url: string): Sql =>
  postgres(url, { max: 2, prepare: false, fetch_types: false, idle_timeout: 5 });
