// Daily closes of the real stocks behind each basket, for the 1-year return and chart. Runs on the prod box once a
// day: Yahoo turns away Worker IPs. Private companies come from our own price snapshots instead.
import postgres from "postgres";
import { BASKETS, YAHOO, tickersOf } from "../src/services/baskets";
import { basketsRepo } from "../src/repos/baskets";

const sql = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false, idle_timeout: 5 });
const priv = new Set(BASKETS.filter((b) => b.private).flatMap(tickersOf));
const tickers = [...new Set(BASKETS.flatMap(tickersOf))];
const done: Record<string, number | string> = {};

for (const t of tickers) {
  try {
    if (priv.has(t)) {
      done[t] = (await basketsRepo.closesFromSnapshots(sql, t)).count;
      continue;
    }
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(YAHOO[t] ?? t)}?range=1y&interval=1d`,
      { headers: { "user-agent": "Mozilla/5.0" } },
    );
    const j = (await r.json()) as {
      chart: { result?: { timestamp: number[]; indicators: { quote: { close: (number | null)[] }[] } }[] };
    };
    const res = j.chart.result?.[0];
    const closes = res?.indicators.quote[0]?.close ?? [];
    const rows = (res?.timestamp ?? []).flatMap((ts, i) =>
      closes[i] == null ? [] : [{ ts: Math.floor(ts / 86400) * 86400, close: closes[i]! }],
    );
    if (rows.length) await basketsRepo.upsertCloses(sql, t, rows);
    done[t] = rows.length;
  } catch (e) {
    done[t] = (e as Error).message;
  }
}
console.log(new Date().toISOString(), JSON.stringify(done));
await sql.end({ timeout: 2 });
