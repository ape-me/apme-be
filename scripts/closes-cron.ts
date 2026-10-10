// Daily closes of every listed stock, ETF and crypto token, for basket returns and charts (AI baskets can pick any of
// them). Runs on the prod box once a day: Yahoo turns away Worker IPs. Private companies come from our own snapshots.
import postgres from "postgres";
import { basketsRepo } from "../src/repos/baskets";
import { closeKey, universe, yahooOf } from "../src/services/baskets";

const sql = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false, idle_timeout: 5 });
const rows = await universe(sql);
const out = { ok: 0, snapshots: 0, empty: [] as string[], mismatch: [] as string[], failed: [] as string[] };

for (const r of rows) {
  const t = closeKey(r);
  try {
    if (r.category === "preipo") {
      await basketsRepo.closesFromSnapshots(sql, t);
      out.snapshots++;
      continue;
    }
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooOf(t))}?range=1y&interval=1d`,
      { headers: { "user-agent": "Mozilla/5.0" } },
    );
    const j = (await res.json()) as {
      chart: {
        result?: {
          meta: { currency: string };
          timestamp: number[];
          indicators: { quote: { close: (number | null)[] }[] };
        }[];
      };
    };
    const c = j.chart.result?.[0];
    const closes = c?.indicators.quote[0]?.close ?? [];
    const days = (c?.timestamp ?? []).flatMap((ts, i) =>
      closes[i] == null ? [] : [{ ts: Math.floor(ts / 86400) * 86400, close: closes[i]! }],
    );
    if (!days.length) {
      out.empty.push(t);
      continue;
    }
    // Yahoo has its own meaning for some symbols (a crypto ticker can be another coin): a USD close must match ours.
    const now = Number(r.mark_usd ?? r.price_usd);
    if (now > 0 && c!.meta.currency === "USD" && Math.abs(days.at(-1)!.close / now - 1) > 0.25) {
      out.mismatch.push(t);
      continue;
    }
    await basketsRepo.upsertCloses(sql, t, days);
    out.ok++;
  } catch {
    out.failed.push(t);
  }
  await new Promise((ok) => setTimeout(ok, 150));
}
console.log(new Date().toISOString(), JSON.stringify(out));
await sql.end({ timeout: 2 });
