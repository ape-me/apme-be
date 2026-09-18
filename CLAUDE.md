# apme-be

Hono API for ApeMe, deployed on Cloudflare Workers. Reads the Postgres the indexer (`/root/ape-indexer`) writes, via Hyperdrive. Receives live trades from the indexer on a signed `/ingest/trades` route and fans them out to phones over Durable Object WebSocket rooms.

Layout: `src/contract.ts` (every boundary shape, zod) → `src/repos` (SQL only) → `src/services` (shaping, caching) → `src/routes` (HTTP only). `src/do/room.ts` is the WebSocket room. No business logic in routes, no SQL outside repos.

Apelist (email waitlist) lives in D1 (`migrations/d1`), routes in `src/routes/apelist.ts`, launch blast in `scripts/blast.ts` (never run automatically). Secrets: TURNSTILE_SECRET, RESEND_API_KEY, IP_SALT.

Rules: never commit secrets (`.dev.vars`, `.env`). Bun for install and scripts, `wrangler` for dev and deploy. Commits carry no AI attribution lines.
