import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { tokenAccounts } from "../lib/rpc";
import { PublicKey } from "@solana/web3.js";
import { USDC_MINT, ata, connection } from "../lib/solana";
import { stocksRepo, type StockRow } from "../repos/stocks";
import { basketsRepo, type BasketLeg } from "../repos/baskets";
import type { UserRow, WalletRow, SettingsRow } from "../repos/account";
import { shapeStock, marketOpen, tradable } from "./shape";
import { quote, submit } from "./swap";
import { news } from "./news";
import { sparks, type Spark } from "./spark";
import { BENCHMARK, pnlCard, costBasis, pnlPct } from "./pnl";
import { walletRepo } from "../repos/wallet";
import { aiRepo, type AiBasketRow } from "../repos/ai";

// A basket: ready-made below, or built by AI from a user's idea (`ai_` ids, stored in ai_baskets). Tickers are
// daily_closes keys (see closeKey) so each resolves to its deepest token at request time. Weights sum to 100.
export type BasketPick = { ticker: string; weight: number; why: string; news?: PickNews | null };
type PickNews = { id: string; title: string; source: string | null; url: string; publishedAt: number };
type Basket = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  about: readonly string[];
  stocks: readonly BasketPick[];
  idea?: string;
  bearCase?: string | null;
};
export const BASKETS: readonly Basket[] = [
  {
    id: "mag7",
    name: "Mag 7",
    tagline: "The 7 biggest US tech companies",
    description: "Apple, Microsoft, Google, Amazon, Meta, Nvidia and Tesla in one buy.",
    about: [
      "The seven companies behind most of the US market's gains.",
      "Own all of them in one buy instead of guessing which one wins.",
    ],
    stocks: [
      { ticker: "AAPL", weight: 15, why: "2 billion devices and a services business that prints cash." },
      { ticker: "MSFT", weight: 20, why: "Cloud, Office and a big stake in OpenAI." },
      { ticker: "GOOGL", weight: 15, why: "Search, YouTube, Google Cloud and Gemini." },
      { ticker: "AMZN", weight: 15, why: "The biggest online store and AWS, the biggest cloud." },
      { ticker: "META", weight: 10, why: "Facebook, Instagram and WhatsApp: 3 billion people a day." },
      { ticker: "NVDA", weight: 20, why: "Makes the chips almost every AI model is trained on." },
      { ticker: "TSLA", weight: 5, why: "Electric cars, batteries, robotaxis and robots." },
    ],
  },
  {
    id: "chips",
    name: "Chip Kings",
    tagline: "The chips and memory AI runs on",
    description: "Nvidia, Micron, SK Hynix, AMD, Sandisk and Intel: whoever builds AI has to buy from them.",
    about: [
      "Every AI model needs chips and memory to train and run.",
      "Whoever wins the AI race, these companies get paid.",
    ],
    stocks: [
      { ticker: "NVDA", weight: 30, why: "The leader in AI chips: most AI runs on its GPUs." },
      { ticker: "MU", weight: 20, why: "US memory maker. AI servers need huge amounts of it." },
      { ticker: "SKHY", weight: 15, why: "Korean memory giant, Nvidia's top supplier of AI memory." },
      { ticker: "AMD", weight: 15, why: "Nvidia's main rival in AI and data center chips." },
      { ticker: "SNDK", weight: 10, why: "Flash storage for all the data AI trains on and produces." },
      { ticker: "INTC", weight: 10, why: "America's chip factory, a bet on a comeback." },
    ],
  },
  {
    id: "crypto",
    name: "Crypto Wall St",
    tagline: "Public companies that live on crypto",
    description: "Coinbase, Robinhood, Strategy and Circle: listed companies that rise and fall with crypto.",
    about: ["Listed companies whose business moves with crypto.", "Crypto exposure through regular stocks."],
    stocks: [
      { ticker: "COIN", weight: 30, why: "The biggest US crypto exchange." },
      { ticker: "HOOD", weight: 25, why: "The trading app millions use for stocks and crypto." },
      { ticker: "MSTR", weight: 25, why: "Holds more bitcoin than any other public company." },
      { ticker: "CRCL", weight: 20, why: "Issues USDC, the dollar stablecoin." },
    ],
  },
  {
    id: "preipo",
    name: "Before They IPO",
    tagline: "Private giants, before the IPO",
    description:
      "OpenAI, Anthropic, SpaceX, Anduril, Neuralink and Polymarket: not on any stock exchange yet.",
    about: [
      "Companies that are still private and not on any stock exchange yet.",
      "Normally only VCs get in before an IPO. These tokens track their value.",
    ],
    stocks: [
      { ticker: "OPENAI", weight: 25, why: "Makes ChatGPT." },
      { ticker: "ANTHROPIC", weight: 25, why: "Makes Claude." },
      { ticker: "SPACEX", weight: 20, why: "Reusable rockets and Starlink internet." },
      { ticker: "ANDURIL", weight: 15, why: "AI-powered defense hardware." },
      { ticker: "NEURALINK", weight: 5, why: "Brain-computer interface chips." },
      { ticker: "POLYMARKET", weight: 10, why: "The biggest prediction market." },
    ],
  },
  {
    id: "market",
    name: "Index & Chill",
    tagline: "The whole US market and Buffett",
    description: "The S&P 500, the Nasdaq 100 and Berkshire Hathaway.",
    about: [
      "The simplest bet: the US market keeps growing.",
      "Spread across hundreds of companies, nothing to watch.",
    ],
    stocks: [
      { ticker: "SPY", weight: 50, why: "The 500 biggest US companies." },
      { ticker: "QQQ", weight: 30, why: "The 100 biggest Nasdaq companies, tech heavy." },
      { ticker: "BRK.B", weight: 20, why: "Warren Buffett's company, owns dozens of businesses." },
    ],
  },
  {
    id: "real",
    name: "Real Stuff",
    tagline: "Gold, oil, copper, uranium",
    description: "Gold, oil, copper miners and uranium: things you can dig up or burn.",
    about: ["Things you can dig up or burn.", "They tend to hold value when money loses it."],
    stocks: [
      { ticker: "GLD", weight: 40, why: "Gold, the classic safe haven." },
      { ticker: "USO", weight: 15, why: "Tracks the price of oil." },
      { ticker: "COPX", weight: 25, why: "Copper miners: copper goes into every wire, EV and data center." },
      { ticker: "URA", weight: 20, why: "Uranium, the fuel for nuclear power." },
    ],
  },
  {
    id: "brands",
    name: "Main Street",
    tagline: "Brands people use every day",
    description: "Nike, Netflix, Costco, Ferrari and Take-Two.",
    about: ["Brands people use every day.", "Real products and loyal customers all over the world."],
    stocks: [
      { ticker: "NKE", weight: 15, why: "The biggest sportswear brand." },
      { ticker: "NFLX", weight: 25, why: "The biggest streaming service." },
      { ticker: "COST", weight: 25, why: "Members-only warehouse stores with very loyal shoppers." },
      { ticker: "RACE", weight: 15, why: "Ferrari: luxury cars with a waiting list." },
      { ticker: "TTWO", weight: 20, why: "Makes GTA. GTA 6 is coming." },
    ],
  },
  {
    id: "retail",
    name: "Retail Army",
    tagline: "What retail traders pile into",
    description: "Palantir, GameStop, Trump Media and Hims & Hers.",
    about: ["The stocks retail traders love most.", "Big moves, both ways."],
    stocks: [
      { ticker: "PLTR", weight: 35, why: "Data and AI software for governments and companies." },
      { ticker: "GME", weight: 20, why: "The original meme stock." },
      { ticker: "DJT", weight: 20, why: "Trump Media, owner of Truth Social." },
      { ticker: "HIMS", weight: 25, why: "Online health care and weight-loss meds." },
    ],
  },
];
// A token's key in daily_closes: crypto gets Yahoo's -USD suffix so SOL the coin never meets a stock called SOL.
export const closeKey = (r: Pick<StockRow, "category" | "underlying" | "symbol">) =>
  r.category === "crypto" ? `${r.underlying ?? r.symbol}-USD` : (r.underlying ?? r.symbol);
// Yahoo's spelling: Hong Kong listings are 4-digit codes, share classes take a dash, newer coins carry an id.
const YAHOO: Record<string, string> = {
  SKHY: "000660.KS",
  "HYPE-USD": "HYPE32196-USD",
  "PENGU-USD": "PENGU34466-USD",
  "PEPE-USD": "PEPE24478-USD",
  "TRUMP-USD": "TRUMP35336-USD",
  "SUI-USD": "SUI20947-USD",
  "TAO-USD": "TAO22974-USD",
  "UNI-USD": "UNI7083-USD",
  "JUP-USD": "JUP29210-USD",
  "ARB-USD": "ARB11841-USD",
};
export const yahooOf = (t: string) =>
  YAHOO[t] ?? (/^\d+$/.test(t) ? `${t.padStart(4, "0")}.HK` : t.replace(".", "-"));
const ISSUER_URL: Record<string, string> = {
  xstocks: "https://xstocks.fi",
  backpack: "https://backpack.exchange",
  prestocks: "https://prestocks.com",
  ondo: "https://ondo.finance",
};
const RISK_NOTES = [
  "You hold tokens that track the real stocks, not the shares themselves.",
  "A token's price can drift from the real stock's price, most of all when the market is closed.",
];
const PRIVATE_NOTE = "Pre-IPO tokens trade above the last private valuation and can swing hard.";
const RANGES = { "1M": 30, "3M": 91, "6M": 182, "1Y": 365 } as const;

const MIN_USD = 10;
const MIN_LEG_USD = 1;
const YEAR_S = 366 * 86400;
const QUOTE_CONCURRENCY = 2; // Jupiter rate-limits a burst of quotes
const now = () => Math.floor(Date.now() / 1000);
const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const fromAi = (r: AiBasketRow): Basket => ({
  id: r.id,
  name: r.name,
  tagline: r.tagline ?? "",
  description: r.idea,
  about: [],
  stocks: JSON.parse(r.picks) as BasketPick[],
  idea: r.idea,
  bearCase: r.bear_case,
});
// An AI basket is a draft for an hour, kept once its author invests, and never shown to anyone else.
export const DRAFT_S = 3600;
async function load(sql: Sql, id: string, viewer?: string) {
  const ai =
    id.startsWith("ai_") && viewer ? (await aiRepo.byId(sql, id, viewer, now() - DRAFT_S))[0] : undefined;
  const b = ai ? fromAi(ai) : BASKETS.find((x) => x.id === id);
  if (!b) throw notFound("basket");
  return b;
}
const names = async (sql: Sql, ids: string[]) => {
  const ai = ids.filter((id) => id.startsWith("ai_"));
  return new Map([
    ...BASKETS.map((b) => [b.id, b.name] as const),
    ...(ai.length ? await aiRepo.names(sql, ai) : []).map((r) => [r.id, r.name] as const),
  ]);
};

// Everything a basket can hold: stocks, ETFs, pre-IPO and crypto, one token per company (the deepest pool).
export const universe = async (sql: Sql) => [
  ...(await stocksRepo.all(sql)),
  ...(await stocksRepo.all(sql, "crypto")),
];

// The token behind each ticker; a ticker we no longer list is left out.
async function resolve(sql: Sql) {
  const by = new Map((await universe(sql)).map((r) => [closeKey(r), r]));
  return (b: Basket) =>
    b.stocks.flatMap((s) => {
      const r = by.get(s.ticker);
      return r ? [{ ...s, row: r }] : [];
    });
}

// The stocks at the given weights (default: the basket's own), rescaled to 100. A zero or missing weight drops one.
function mix<T extends BasketPick>(stocks: T[], weights?: Record<string, number>) {
  const unknown = Object.keys(weights ?? {}).filter((t) => !stocks.some((s) => s.ticker === t));
  if (unknown.length) throw new HttpError(400, "unknown_ticker", { tickers: unknown });
  const kept = stocks
    .map((s) => ({ ...s, weight: weights ? (weights[s.ticker] ?? 0) : s.weight }))
    .filter((s) => s.weight > 0);
  if (!kept.length) throw new HttpError(400, "empty_mix");
  const sum = kept.reduce((n, s) => n + s.weight, 0);
  return kept.map((s) => ({ ...s, weight: round2((s.weight / sum) * 100) }));
}

type Close = { ticker: string; ts: string; close: number };
type Point = { t: number; value: number };
type Weighted = { ticker: string; weight: number };

// $100 split by weight on the first day every stock has a close (or `from`, if later), held to the last close.
// Days a market was shut carry the previous close forward.
function backtest(stocks: Weighted[], rows: Close[], from = 0) {
  const tickers = stocks.map((s) => s.ticker);
  const mine = rows.filter((r) => tickers.includes(r.ticker));
  const first = new Map<string, number>();
  for (const r of mine) if (!first.has(r.ticker)) first.set(r.ticker, Number(r.ts));
  if (!tickers.length || tickers.some((t) => !first.has(t))) return null;
  const start = Math.max(from, ...first.values());
  const last = new Map<string, number>();
  const base = new Map<string, number>();
  const points: Point[] = [];
  const days = [...new Set(mine.map((r) => Number(r.ts)))];
  let i = 0;
  for (const d of days) {
    for (; i < mine.length && Number(mine[i]!.ts) === d; i++) last.set(mine[i]!.ticker, mine[i]!.close);
    if (d < start) continue;
    if (!base.size) for (const t of tickers) base.set(t, last.get(t)!);
    const value = stocks.reduce((s, x) => s + (x.weight * last.get(x.ticker)!) / base.get(x.ticker)!, 0);
    points.push({ t: d, value: round2(value) });
  }
  const end = points.at(-1)!.t;
  return {
    points,
    returnPct: round2(points.at(-1)!.value - 100),
    returnLabel: end - start >= 350 * 86400 ? "1Y" : `since ${day(start)}`,
    byTicker: new Map(tickers.map((t) => [t, round2((last.get(t)! / base.get(t)! - 1) * 100)])),
  };
}

// Return over each window, from the same series the chart draws; null when the series is younger than the window.
const ranges = (points: Point[]) => {
  const end = points.at(-1)!;
  return Object.fromEntries(
    Object.entries(RANGES).map(([k, days]) => {
      const at = points.find((p) => p.t >= end.t - days * 86400);
      const covered = at && points[0]!.t <= end.t - (days - 5) * 86400;
      return [k, covered ? round2((end.value / at.value - 1) * 100) : null];
    }),
  ) as Record<keyof typeof RANGES, number | null>;
};

// Day-to-day swings, the deepest fall from a high, and the worst and best single days.
function risk(points: Point[], priv: boolean) {
  const days = points.slice(1).map((p, i) => ({ t: p.t, r: p.value / points[i]!.value - 1 }));
  const mean = days.reduce((s, d) => s + d.r, 0) / (days.length || 1);
  const sd = Math.sqrt(days.reduce((s, d) => s + (d.r - mean) ** 2, 0) / (days.length || 1));
  const volatilityPct = round2(sd * Math.sqrt(252) * 100);
  let peak = points[0]!;
  let dd = { pct: 0, from: peak.t, to: peak.t };
  for (const p of points) {
    if (p.value > peak.value) peak = p;
    const pct = (p.value / peak.value - 1) * 100;
    if (pct < dd.pct) dd = { pct: round2(pct), from: peak.t, to: p.t };
  }
  const sorted = [...days].sort((a, b) => a.r - b.r);
  const pick = (d?: { t: number; r: number }) => (d ? { pct: round2(d.r * 100), t: d.t } : null);
  return {
    level: volatilityPct < 15 ? "Low" : volatilityPct < 30 ? "Medium" : "High",
    volatilityPct,
    maxDrawdown: dd,
    worstDay: pick(sorted[0]),
    bestDay: pick(sorted.at(-1)),
    notes: priv ? [...RISK_NOTES, PRIVATE_NOTE] : RISK_NOTES,
  };
}

const card = (b: Basket, stocks: { row: StockRow }[], bt: ReturnType<typeof backtest>) => ({
  id: b.id,
  name: b.name,
  tagline: b.tagline,
  stockCount: stocks.length,
  logos: stocks.flatMap((s) => (s.row.logo ? [s.row.logo] : [])).slice(0, 5),
  return1y: bt?.returnPct ?? null,
  returnLabel: bt?.returnLabel ?? null,
  minUsd: MIN_USD,
  tradable: stocks.length > 0 && stocks.every((s) => tradable(s.row) && !s.row.halted),
});

export async function basketList(sql: Sql) {
  const [pick, closes] = await Promise.all([
    resolve(sql),
    basketsRepo.closes(
      sql,
      [...new Set(BASKETS.flatMap((b) => b.stocks.map((s) => s.ticker)))],
      now() - YEAR_S,
    ),
  ]);
  return {
    baskets: BASKETS.map((b) => {
      const stocks = pick(b);
      return card(b, stocks, stocks.length ? backtest(mix(stocks), closes) : null);
    }),
    asOf: now(),
  };
}

// Chart, returns over each window, risk and the S&P 500 over the same days, for one mix of a basket's stocks.
async function performance(sql: Sql, stocks: (Weighted & { row: StockRow })[]) {
  const closes = await basketsRepo.closes(sql, [...stocks.map((s) => s.ticker), BENCHMARK], now() - YEAR_S);
  const bt = backtest(stocks, closes);
  const bench = bt ? backtest([{ ticker: BENCHMARK, weight: 100 }], closes, bt.points[0]!.t) : null;
  return {
    bt,
    chart: bt ? { range: bt.returnLabel, points: bt.points } : null,
    performance: bt
      ? {
          ranges: ranges(bt.points),
          benchmark: bench
            ? {
                name: "S&P 500",
                ticker: BENCHMARK,
                returnPct: bench.returnPct,
                returnLabel: bench.returnLabel,
                ranges: ranges(bench.points),
                points: bench.points,
              }
            : null,
        }
      : null,
    risk: bt
      ? risk(
          bt.points,
          stocks.some((s) => s.row.category === "preipo"),
        )
      : null,
  };
}

export async function basketDetail(sql: Sql, id: string, viewer?: string) {
  const [b, pick] = await Promise.all([load(sql, id, viewer), resolve(sql)]);
  const stocks = pick(b);
  if (!stocks.length) throw new HttpError(409, "basket_unavailable");
  const mixed = mix(stocks);
  const { bt, ...perf } = await performance(sql, mixed);
  const ranked = bt ? [...bt.byTicker].sort((x, y) => y[1] - x[1]) : [];
  const open = marketOpen();
  return {
    ...card(b, stocks, bt),
    description: b.description,
    about: b.about,
    ai: b.idea ? { idea: b.idea, bearCase: b.bearCase ?? null } : null,
    feeBps: 100,
    ...perf,
    rebalance: {
      available: false,
      note: "Weights are set when you buy. Auto-rebalancing is coming soon.",
    },
    best: ranked[0] ? { symbol: ranked[0][0], return1y: ranked[0][1] } : null,
    worst: ranked.at(-1) ? { symbol: ranked.at(-1)![0], return1y: ranked.at(-1)![1] } : null,
    stocks: mixed.map((s) => ({
      ticker: s.ticker,
      weight: s.weight,
      return1y: bt?.byTicker.get(s.ticker) ?? null,
      why: s.why,
      news: s.news ?? null,
      links: {
        issuer: ISSUER_URL[s.row.issuer] ?? null,
        solscan: `https://solscan.io/token/${s.row.mint}`,
        yahoo:
          s.row.category === "preipo"
            ? null
            : `https://finance.yahoo.com/quote/${encodeURIComponent(yahooOf(s.ticker))}`,
      },
      stock: shapeStock(s.row, open),
    })),
  };
}

// The slider: the same basket at the user's weights, what that mix did over the last year.
export async function basketPreview(sql: Sql, id: string, weights: Record<string, number>, viewer?: string) {
  const [b, pick] = await Promise.all([load(sql, id, viewer), resolve(sql)]);
  const mixed = mix(pick(b), weights);
  const { bt, ...perf } = await performance(sql, mixed);
  return {
    weights: mixed.map((s) => ({ ticker: s.ticker, weight: s.weight })),
    return1y: bt?.returnPct ?? null,
    returnLabel: bt?.returnLabel ?? null,
    ...perf,
  };
}

// The basket's own news: only stories tagged to its stocks, newest first, a few per stock.
export async function basketNews(sql: Sql, id: string, limit: number, viewer?: string) {
  const [b, pick] = await Promise.all([load(sql, id, viewer), resolve(sql)]);
  const stocks = pick(b);
  if (!stocks.length) return { items: [] };
  return {
    items: await news.feed(sql, {
      mints: stocks.map((s) => s.row.mint),
      only: true,
      limit,
      before: null,
      minImpact: 1,
      perStock: 3,
      withImage: false,
    }),
  };
}

// What each basket still holds per mint, from its own confirmed swaps: bought minus sold, cost scaled to what is left.
function holdings(legs: BasketLeg[], wallet?: string) {
  const out = new Map<string, Map<string, { bought: bigint; sold: bigint; cost: number; opened: number }>>();
  for (const l of legs) {
    if (wallet && l.wallet !== wallet) continue;
    const buy = l.side === "buy";
    const mint = buy ? l.output_mint : l.input_mint;
    const m = out.get(l.basket_id) ?? out.set(l.basket_id, new Map()).get(l.basket_id)!;
    const h =
      m.get(mint) ?? m.set(mint, { bought: 0n, sold: 0n, cost: 0, opened: Number(l.created_at) }).get(mint)!;
    if (buy) {
      h.bought += BigInt(l.out_raw ?? 0);
      h.cost += Number(l.in_usd ?? 0);
    } else if ((h.sold += BigInt(l.in_raw)) >= h.bought - h.bought / 1000n) m.delete(mint); // a sell-all can leave dust
  }
  return out;
}

export async function basketPositions(sql: Sql, userId: string) {
  const legs = await basketsRepo.legs(sql, userId);
  const held = holdings(legs);
  const mints = [...new Set([...held.values()].flatMap((m) => [...m.keys()]))];
  const [found, sp, named] = await Promise.all([
    mints.length ? walletRepo.known(sql, mints) : [], // held: excluded or not
    mints.length ? sparks(sql, mints) : new Map<string, Spark>(),
    names(sql, [...held.keys()]),
  ]);
  const rows = new Map(found.map((r) => [r.mint, r]));
  const positions = [...held].flatMap(([basketId, m]) => {
    const parts = [...m].map(([mint, h]) => {
      const r = rows.get(mint);
      const left = h.bought - h.sold;
      const amount = r ? (Number(left) / 10 ** r.decimals) * Number(r.multiplier ?? 1) : 0;
      const stock = {
        mint,
        symbol: r?.symbol ?? null,
        logo: r?.image ?? null,
        amount,
        valueUsd: round2(amount * Number(r?.price_usd ?? 0)),
      };
      return {
        stock,
        paid: (h.cost * Number(left)) / Number(h.bought),
        opened: h.opened,
        hourly: sp.get(mint),
      };
    });
    // The basket's value at each hour: what it holds now, priced at that hour. Null if any stock lacks the history.
    const at = (price: (s?: Spark) => number | null | undefined) => {
      const p = parts.map((x) => price(x.hourly));
      return p.every((n) => n != null)
        ? round2(parts.reduce((s, x, i) => s + x.stock.amount * p[i]!, 0))
        : null;
    };
    const hours = Array.from({ length: 24 }, (_, i) => at((s) => s?.spark?.[i]));
    const spark = hours.every((v) => v != null) ? (hours as number[]) : null;
    const paidUsd = round2(parts.reduce((s, x) => s + x.paid, 0));
    const valueUsd = round2(parts.reduce((s, x) => s + x.stock.valueUsd, 0));
    if (valueUsd < 0.01) return [];
    return [
      {
        basketId,
        name: named.get(basketId) ?? basketId,
        paidUsd,
        valueUsd,
        pnlUsd: round2(valueUsd - paidUsd),
        pnlPct: paidUsd ? round2((valueUsd / paidUsd - 1) * 100) : null,
        openedAt: Math.min(...parts.map((x) => x.opened)),
        rebalance: legs.some((l) => l.basket_id === basketId && l.rebalance), // coming soon: always false today
        spark,
        prevClose: at((s) => s?.prevClose),
        stocks: parts.map((x) => x.stock),
      },
    ];
  });
  return { positions: positions.sort((a, b) => b.valueUsd - a.valueUsd) };
}

// The share card after a sell: what this order got back, against what those shares cost, and the S&P 500 over the same hold.
export async function basketPnl(sql: Sql, user: UserRow, orderId: string) {
  const [o] = await basketsRepo.order(sql, orderId, user.id);
  if (!o) throw notFound("basket order");
  if (o.side !== "sell") throw new HttpError(409, "not_a_sell");
  const [fills, legStatus] = await Promise.all([
    walletRepo.fills(sql, o.wallet),
    basketsRepo.orderLegs(sql, orderId),
  ]);
  const ids = new Set(legStatus.map((l) => l.id));
  const basis = costBasis(fills);
  const parts = fills.flatMap((f) => {
    const b = ids.has(f.id) ? basis.get(f.id) : null;
    return b
      ? [
          {
            mint: f.input_mint,
            paid: b.paid,
            received: Number(f.out_raw ?? 0) / 1e6,
            opened: b.opened,
            at: Number(f.created_at),
          },
        ]
      : [];
  });
  if (!parts.length) throw new HttpError(409, "sell_not_confirmed");
  const meta = new Map(
    (
      await walletRepo.known(
        sql,
        parts.map((x) => x.mint),
      )
    ).map((r) => [r.mint, r]),
  );
  const stocks = parts
    .map((x) => ({
      mint: x.mint,
      symbol: meta.get(x.mint)?.symbol ?? null,
      logo: meta.get(x.mint)?.image ?? null,
      paidUsd: round2(x.paid),
      receivedUsd: round2(x.received),
      pnlPct: pnlPct(x.paid, x.received),
    }))
    .sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0));
  const { name } = await load(sql, o.basket_id, user.id);
  const c = await pnlCard(sql, user, name.toLowerCase(), parts, {
    paid: parts.reduce((s, x) => s + x.paid, 0),
    received: parts.reduce((s, x) => s + x.received, 0),
    openedAt: Math.min(...parts.map((x) => x.opened)),
    closedAt: Math.min(...parts.map((x) => x.at)),
  });
  return {
    orderId,
    basketId: o.basket_id,
    name,
    complete: legStatus.every((l) => l.status === "confirmed"), // false while a leg is still landing: card may move
    ...c,
    best: stocks[0] ?? null,
    worst: stocks.length > 1 ? stocks.at(-1)! : null,
    stocks,
  };
}

type Ctx = { env: Env; sql: Sql; user: UserRow; wallets: WalletRow[]; settings: SettingsRow };

// One basket order, one swap quote per stock. A stock that will not quote fails the whole order, by name.
async function quoteLegs(
  c: Ctx,
  basketId: string,
  side: "buy" | "sell",
  taker: string,
  amountUsd: number,
  legs: { mint: string; symbol: string; amount: bigint; weight: number }[],
  opts: { existing?: string; weights?: Record<string, number> } = {}, // a retry adds legs to the order it finishes
) {
  const { existing, weights } = opts;
  const orderId = existing ?? crypto.randomUUID();
  if (!existing)
    await basketsRepo.insertOrder(c.sql, {
      id: orderId,
      userId: c.user.id,
      wallet: taker,
      basketId,
      side,
      amountUsd,
      weights: weights ?? null,
      t: now(),
    });
  const quoted: (Awaited<ReturnType<typeof quote>> & { weight: number })[] = [];
  try {
    for (let i = 0; i < legs.length; i += QUOTE_CONCURRENCY)
      quoted.push(
        ...(await Promise.all(
          legs.slice(i, i + QUOTE_CONCURRENCY).map(async (l) => {
            const mints =
              side === "buy"
                ? { inputMint: "usdc", outputMint: l.mint }
                : { inputMint: l.mint, outputMint: "usdc" };
            const q = await quote(
              c.env,
              c.sql,
              c.user,
              c.wallets,
              { ...c.settings, slippage_bps: 0 }, // auto: Jupiter sizes it per stock, pre-IPO needs more than a flat 1%
              { ...mints, amount: l.amount.toString(), taker, sponsor: true },
              orderId,
            ).catch((e: Error) => {
              const h = e instanceof HttpError ? e : null;
              throw new HttpError(h?.status ?? 500, e.message, { ...h?.data, symbol: l.symbol });
            });
            return { weight: l.weight, ...q };
          }),
        )),
      );
  } catch (e) {
    if (!existing) await basketsRepo.setStatus(c.sql, orderId, "failed");
    throw e;
  }
  return {
    orderId,
    basketId,
    side,
    amountUsd,
    feeUsd: round2(quoted.reduce((s, q) => s + q.fee.usd, 0)),
    expiresAt: Math.min(...quoted.map((q) => q.expiresAt)),
    legs: quoted,
  };
}

export async function quoteBuy(
  c: Ctx,
  id: string,
  amountUsd: number,
  taker: string,
  weights?: Record<string, number>,
) {
  const [b, pick] = await Promise.all([load(c.sql, id, c.user.id), resolve(c.sql)]);
  const stocks = mix(pick(b), weights);
  if (amountUsd < MIN_USD) throw new HttpError(400, "below_minimum", { minUsd: MIN_USD });
  // Each stock is its own swap: too small a slice will not route.
  const smallest = Math.min(...stocks.map((s) => s.weight));
  if ((amountUsd * smallest) / 100 < MIN_LEG_USD)
    throw new HttpError(400, "below_minimum", { minUsd: Math.ceil((MIN_LEG_USD * 100) / smallest) });
  // Check the wallet up front: otherwise every leg quotes fine and the last ones fail at execute.
  const usdc = await connection(c.env)
    .getTokenAccountBalance(ata(new PublicKey(taker), new PublicKey(USDC_MINT)))
    .catch(() => null);
  const heldUsd = Number(usdc?.value.uiAmount ?? 0);
  if (heldUsd < amountUsd)
    throw new HttpError(400, "insufficient_usdc", {
      neededUsd: amountUsd,
      heldUsd,
      shortUsd: Math.ceil((amountUsd - heldUsd) * 100) / 100,
    });
  return quoteLegs(
    c,
    b.id,
    "buy",
    taker,
    amountUsd,
    stocks.map((s) => ({
      mint: s.row.mint,
      symbol: s.row.symbol,
      amount: BigInt(Math.floor((amountUsd * 1e6 * s.weight) / 100)),
      weight: s.weight,
    })),
    { weights: Object.fromEntries(stocks.map((s) => [s.ticker, s.weight])) },
  );
}

// Sells everything this wallet's position in the basket holds, never more than the wallet still has on chain.
export async function quoteSell(c: Ctx, id: string, taker: string) {
  const b = await load(c.sql, id, c.user.id);
  const [legs, accounts] = await Promise.all([
    basketsRepo.legs(c.sql, c.user.id),
    tokenAccounts(c.env, taker),
  ]);
  const held = holdings(legs, taker).get(b.id);
  const onChain = new Map(accounts.map((a) => [a.mint, BigInt(a.amount)]));
  const rows = new Map(
    held?.size ? (await stocksRepo.byMints(c.sql, [...held.keys()])).map((r) => [r.mint, r]) : [],
  );
  const sell = [...(held ?? [])].flatMap(([mint, h]) => {
    const r = rows.get(mint);
    const left = h.bought - h.sold;
    const bal = onChain.get(mint) ?? 0n;
    // A fill can land a hair above its quote: sell that dust too instead of stranding it.
    const amount = bal <= left + left / 1000n ? bal : left;
    if (!r || amount <= 0n) return [];
    return [
      {
        mint,
        symbol: r.symbol,
        amount,
        usd: (Number(amount) / 10 ** r.decimals) * Number(r.multiplier ?? 1) * Number(r.price_usd ?? 0),
      },
    ];
  });
  if (!sell.length) throw new HttpError(409, "nothing_to_sell");
  const total = sell.reduce((s, x) => s + x.usd, 0);
  return quoteLegs(
    c,
    b.id,
    "sell",
    taker,
    round2(total),
    sell.map((x) => ({ ...x, weight: total ? round2((x.usd / total) * 100) : 0 })),
  );
}

type OrderLeg = Awaited<ReturnType<typeof basketsRepo.orderLegs>>[number];
const stockOf = (l: OrderLeg) => (l.side === "buy" ? l.output_mint : l.input_mint);
// Done when every stock in the order has a landed leg, however many tries it took.
const orderStatus = (legs: OrderLeg[]) => {
  const all = new Set(legs.map(stockOf));
  const landed = new Set(legs.filter((l) => l.status === "confirmed").map(stockOf));
  return landed.size === all.size ? "done" : landed.size ? "partial" : "failed";
};

// Every signed leg goes out at once; the order is done, partial or failed by how many stocks landed.
export async function submitBasket(
  env: Env,
  sql: Sql,
  user: UserRow,
  orderId: string,
  signed: { requestId: string; signedTransaction: string }[],
) {
  const [o] = await basketsRepo.order(sql, orderId, user.id);
  if (!o) throw notFound("basket order");
  const ids = new Set((await basketsRepo.orderLegs(sql, orderId)).map((r) => r.id));
  if (signed.some((s) => !ids.has(s.requestId))) throw badRequest("requestId is not part of this order");
  const results = await Promise.allSettled(
    signed.map((s) => submit(env, sql, user, s.requestId, s.signedTransaction)),
  );
  const legs = results.map((r, i) =>
    r.status === "fulfilled"
      ? { requestId: signed[i]!.requestId, status: "confirmed", signature: r.value.signature, error: null }
      : {
          requestId: signed[i]!.requestId,
          status: "failed",
          signature: null,
          error: (r.reason as Error).message,
        },
  );
  const status = orderStatus(await basketsRepo.orderLegs(sql, orderId));
  await basketsRepo.setStatus(sql, orderId, status);
  // The first buy that lands keeps an AI draft for good.
  if (o.side === "buy" && status !== "failed" && o.basket_id.startsWith("ai_"))
    await aiRepo.save(sql, o.basket_id, now());
  return { orderId, status, legs };
}

// A partial buy: fresh quotes for just the stocks that have not landed, same amounts, same order.
export async function retryBuy(c: Ctx, orderId: string) {
  const [o] = await basketsRepo.order(c.sql, orderId, c.user.id);
  if (!o) throw notFound("basket order");
  if (o.side !== "buy") throw new HttpError(409, "retry_buy_only", { hint: "call /sell again" });
  const legs = await basketsRepo.orderLegs(c.sql, orderId);
  const busy = new Set(legs.filter((l) => l.status === "confirmed" || l.status === "submitted").map(stockOf));
  const todo = [...new Map(legs.filter((l) => !busy.has(stockOf(l))).map((l) => [stockOf(l), l])).values()];
  if (!todo.length) throw new HttpError(409, "nothing_to_retry");
  return quoteLegs(
    c,
    o.basket_id,
    "buy",
    o.wallet,
    round2(todo.reduce((s, l) => s + Number(l.in_raw), 0) / 1e6),
    todo.map((l) => ({
      mint: stockOf(l),
      symbol: l.symbol,
      amount: BigInt(l.in_raw),
      weight: round2((Number(l.in_raw) / 1e6 / Number(o.amount_usd)) * 100),
    })),
    { existing: orderId },
  );
}
