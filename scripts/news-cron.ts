// Runs on the prod box (Bun in Docker), not in the Worker: fetching every article costs a redirect request and a
// Worker only gets 1000 subrequests per invocation. Talks to Postgres directly and pushes new items to the Worker
// for the WebSocket rooms. One pass per invocation; the container sleeps between passes.
import postgres from "postgres";
import { ingestNews, scoreNews } from "../src/services/news";
import type { Env } from "../src/env";

const env = process.env as unknown as Env;
const sql = postgres(process.env.DATABASE_URL!, { max: 4, prepare: false, idle_timeout: 5 });
const minute = new Date().getUTCMinutes();

const r = await ingestNews(env, sql, minute);
const s = await scoreNews(env, sql, 200);
console.log(new Date().toISOString(), JSON.stringify({ ...r, ...s }));
await sql.end({ timeout: 2 });
