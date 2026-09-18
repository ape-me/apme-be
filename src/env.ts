export type Env = {
  ENV: string;
  PG?: Hyperdrive;
  DATABASE_URL?: string;      // dev fallback when no Hyperdrive binding
  INGEST_SECRET: string;
  ROOMS: DurableObjectNamespace;
  RL_READ?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  RL_APELIST?: { limit(o: { key: string }): Promise<{ success: boolean }> };
  DB: D1Database;
  ALLOWED_ORIGINS: string;
  SITE_URL: string;
  PUBLIC_URL: string;
  TURNSTILE_SECRET: string;
  RESEND_API_KEY?: string;
  IP_SALT: string;
};
