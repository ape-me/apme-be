export type Env = {
  ENV: string;
  PG?: Hyperdrive;
  DATABASE_URL?: string;      // dev fallback when no Hyperdrive binding
  INGEST_SECRET: string;
  METRICS_TOKEN?: string;     // bearer for /metrics (Prometheus on the ops box)
  RPC_URL: string;
  ADMIN_TOKEN?: string;
  PRIVY_APP_ID?: string;      // Privy app; identity tokens verified against its JWKS
  INVITE_GATE?: string;       // "0" opens trading to everyone; default gated
  INVITES_PER_USER?: string;  // personal invite code uses, default 5       // bearer for /v1/admin (stock overrides)            // Solana JSON-RPC for wallet balances (secret)
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
