// The news loop on the prod box (Bun in Docker, always on): one pass a minute, not in the Worker, because fetching
// every article costs a redirect request and a Worker only gets 1000 subrequests per invocation. Talks to Postgres
// directly and pushes new items to the Worker for the WebSocket rooms. A slow pass just starts the next one late.
import postgres from "postgres";
import { ingestNews, scoreNews } from "../src/services/news";
import type { Env } from "../src/env";

const env = process.env as unknown as Env;
const sql = postgres(process.env.DATABASE_URL!, { max: 4, prepare: false, idle_timeout: 30 });

for (let pass = 0; ; pass++) {
  const started = Date.now();
  try {
    const r = await ingestNews(env, sql, pass);
    const s = await scoreNews(env, sql, 200);
    console.log(new Date().toISOString(), JSON.stringify({ ...r, ...s, ms: Date.now() - started }));
  } catch (e) {
    console.error(new Date().toISOString(), "news pass failed", (e as Error).message);
  }
  await new Promise((ok) => setTimeout(ok, Math.max(1000, 60_000 - (Date.now() - started))));
}
