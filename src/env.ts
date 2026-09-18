export type Env = {
  ENV: string;
  PG?: Hyperdrive;
  DATABASE_URL?: string;      // dev fallback when no Hyperdrive binding
  INGEST_SECRET: string;
  ROOMS: DurableObjectNamespace;
  RL_READ?: { limit(o: { key: string }): Promise<{ success: boolean }> };
};
