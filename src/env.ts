export type Env = {
  ENV: string;
  PG?: Hyperdrive;
  DATABASE_URL?: string; // dev fallback when no Hyperdrive binding
  INGEST_SECRET: string;
  METRICS_TOKEN?: string; // bearer for /metrics (Prometheus on the ops box)
  RPC_URL: string;
  ADMIN_TOKEN?: string;
  PRIVY_APP_ID?: string; // Privy app; identity tokens verified against its JWKS
  PRIVY_APP_SECRET?: string; // server-to-server: look up a user's wallets when the client only has an access token
  INVITE_GATE?: string; // "0" opens trading to everyone; default gated
  INVITES_PER_USER?: string; // personal invite code uses, default 5
  GAS_WALLET_SECRET?: string; // base58 keypair of our fee payer (secret)
  FEE_WALLET?: string; // pubkey that receives the 1% (USDC)
  JUP_API_KEY?: string;
  FINNHUB_KEY?: string;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  CF_API_TOKEN?: string;
  AI?: { run: (model: string, input: unknown, opts?: unknown) => Promise<unknown> }; // developers.jup.ag key; falls back to lite-api without it       // bearer for /v1/admin (stock overrides)            // Solana JSON-RPC for wallet balances (secret)
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
