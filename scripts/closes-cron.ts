// Daily closes of every listed stock, ETF and crypto token, for basket returns and charts (AI baskets can pick any of
// them). Runs on the prod box once a day: Yahoo turns away Worker IPs. Private companies come from our own snapshots;
// Solana coins Yahoo does not carry come from GeckoTerminal.
import postgres from "postgres";
import { basketsRepo } from "../src/repos/baskets";
import { closeKey, universe, yahooOf } from "../src/services/baskets";

type Day = { ts: number; close: number };
const sql = postgres(process.env.DATABASE_URL!, { max: 2, prepare: false, idle_timeout: 5 });
const rows = await universe(sql);
const out = { yahoo: 0, gecko: 0, snapshots: 0, missing: [] as string[], failed: [] as string[] };
const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const day = (ts: number) => Math.floor(ts / 86400) * 86400;

async function yahoo(t: string) {
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
    closes[i] == null ? [] : [{ ts: day(ts), close: closes[i]! }],
  );
  return { days, usd: c?.meta.currency === "USD" };
}

// Free tier: ~30 calls a minute, so calls are spaced out and a 429 waits for the window to clear.
async function geckoGet(path: string, tries = 3): Promise<{ data?: unknown }> {
  await sleep(3000);
  const r = await fetch(`https://api.geckoterminal.com/api/v2/networks/solana/${path}`);
  if (r.status === 429 && tries > 1) {
    await sleep(30_000);
    return geckoGet(path, tries - 1);
  }
  return r.json() as Promise<{ data?: unknown }>;
}

// The token's deepest Solana pool, a year of daily candles priced in USD, oldest first.
async function gecko(mint: string): Promise<Day[]> {
  const pools = (await geckoGet(`tokens/${mint}/pools?page=1`)).data as
    { attributes: { address: string } }[] | undefined;
  const pool = pools?.[0]?.attributes.address;
  if (!pool) return [];
  const candles = (await geckoGet(`pools/${pool}/ohlcv/day?limit=365&currency=usd&token=${mint}`)).data as
    { attributes: { ohlcv_list: number[][] } } | undefined;
  return (candles?.attributes.ohlcv_list ?? []).map((c) => ({ ts: day(c[0]!), close: c[4]! })).toReversed();
}

// Yahoo has its own meaning for some symbols (a crypto ticker can be another coin): a USD close must match ours.
const matches = (days: Day[], now: number) => !(now > 0) || Math.abs(days.at(-1)!.close / now - 1) <= 0.25;

for (const r of rows) {
  const t = closeKey(r);
  const now = Number(r.mark_usd ?? r.price_usd);
  try {
    if (r.category === "preipo") {
      await basketsRepo.closesFromSnapshots(sql, t);
      out.snapshots++;
      continue;
    }
    const y = await yahoo(t);
    await sleep(150);
    if (y.days.length && (!y.usd || matches(y.days, now))) {
      await basketsRepo.upsertCloses(sql, t, y.days);
      out.yahoo++;
      continue;
    }
    const g = r.category === "crypto" ? await gecko(r.mint) : [];
    if (g.length && matches(g, now)) {
      await basketsRepo.upsertCloses(sql, t, g);
      out.gecko++;
    } else out.missing.push(t);
  } catch {
    out.failed.push(t);
  }
}
console.log(new Date().toISOString(), JSON.stringify(out));
await sql.end({ timeout: 2 });
process.exit(0); // idle keep-alive sockets would hold the run open
