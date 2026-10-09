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

// Ready-made baskets, equal weight. Stocks are real-world tickers so each resolves to its deepest token at request
// time. `private` ones have no exchange closes; their chart comes from our own price snapshots.
type Basket = {
  id: string;
  name: string;
  tagline: string;
  description: string;
  about: readonly string[];
  stocks: readonly { ticker: string; why: string }[];
  private?: boolean;
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
      { ticker: "AAPL", why: "2 billion devices and a services business that prints cash." },
      { ticker: "MSFT", why: "Cloud, Office and a big stake in OpenAI." },
      { ticker: "GOOGL", why: "Search, YouTube, Google Cloud and Gemini." },
      { ticker: "AMZN", why: "The biggest online store and AWS, the biggest cloud." },
      { ticker: "META", why: "Facebook, Instagram and WhatsApp: 3 billion people a day." },
      { ticker: "NVDA", why: "Makes the chips almost every AI model is trained on." },
      { ticker: "TSLA", why: "Electric cars, batteries, robotaxis and robots." },
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
      { ticker: "NVDA", why: "The leader in AI chips: most AI runs on its GPUs." },
      { ticker: "MU", why: "US memory maker. AI servers need huge amounts of it." },
      { ticker: "SKHY", why: "Korean memory giant, Nvidia's top supplier of AI memory." },
      { ticker: "AMD", why: "Nvidia's main rival in AI and data center chips." },
      { ticker: "SNDK", why: "Flash storage for all the data AI trains on and produces." },
      { ticker: "INTC", why: "America's chip factory, a bet on a comeback." },
    ],
  },
  {
    id: "crypto",
    name: "Crypto Wall St",
    tagline: "Public companies that live on crypto",
    description: "Coinbase, Robinhood, Strategy and Circle: listed companies that rise and fall with crypto.",
    about: ["Listed companies whose business moves with crypto.", "Crypto exposure through regular stocks."],
    stocks: [
      { ticker: "COIN", why: "The biggest US crypto exchange." },
      { ticker: "HOOD", why: "The trading app millions use for stocks and crypto." },
      { ticker: "MSTR", why: "Holds more bitcoin than any other public company." },
      { ticker: "CRCL", why: "Issues USDC, the dollar stablecoin." },
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
      { ticker: "OPENAI", why: "Makes ChatGPT." },
      { ticker: "ANTHROPIC", why: "Makes Claude." },
      { ticker: "SPACEX", why: "Reusable rockets and Starlink internet." },
      { ticker: "ANDURIL", why: "AI-powered defense hardware." },
      { ticker: "NEURALINK", why: "Brain-computer interface chips." },
      { ticker: "POLYMARKET", why: "The biggest prediction market." },
    ],
    private: true,
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
      { ticker: "SPY", why: "The 500 biggest US companies." },
      { ticker: "QQQ", why: "The 100 biggest Nasdaq companies, tech heavy." },
      { ticker: "BRK.B", why: "Warren Buffett's company, owns dozens of businesses." },
    ],
  },
  {
    id: "real",
    name: "Real Stuff",
    tagline: "Gold, oil, copper, uranium",
    description: "Gold, oil, copper miners and uranium: things you can dig up or burn.",
    about: ["Things you can dig up or burn.", "They tend to hold value when money loses it."],
    stocks: [
      { ticker: "GLD", why: "Gold, the classic safe haven." },
      { ticker: "USO", why: "Tracks the price of oil." },
      { ticker: "COPX", why: "Copper miners: copper goes into every wire, EV and data center." },
      { ticker: "URA", why: "Uranium, the fuel for nuclear power." },
    ],
  },
  {
    id: "brands",
    name: "Main Street",
    tagline: "Brands people use every day",
    description: "Nike, Netflix, Costco, Ferrari and Take-Two.",
    about: ["Brands people use every day.", "Real products and loyal customers all over the world."],
    stocks: [
      { ticker: "NKE", why: "The biggest sportswear brand." },
      { ticker: "NFLX", why: "The biggest streaming service." },
      { ticker: "COST", why: "Members-only warehouse stores with very loyal shoppers." },
      { ticker: "RACE", why: "Ferrari: luxury cars with a waiting list." },
      { ticker: "TTWO", why: "Makes GTA. GTA 6 is coming." },
    ],
  },
  {
    id: "retail",
    name: "Retail Army",
    tagline: "What retail traders pile into",
    description: "Palantir, GameStop, Trump Media and Hims & Hers.",
    about: ["The stocks retail traders love most.", "Big moves, both ways."],
    stocks: [
      { ticker: "PLTR", why: "Data and AI software for governments and companies." },
      { ticker: "GME", why: "The original meme stock." },
      { ticker: "DJT", why: "Trump Media, owner of Truth Social." },
      { ticker: "HIMS", why: "Online health care and weight-loss meds." },
    ],
  },
];
export const tickersOf = (b: Basket) => b.stocks.map((s) => s.ticker);
// Yahoo spells a few tickers its own way; private companies have no page.
export const YAHOO: Record<string, string> = { "BRK.B": "BRK-B", SKHY: "000660.KS" };
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
const BENCHMARK = "SPY";

const MIN_USD = 10;
const YEAR_S = 366 * 86400;
const QUOTE_CONCURRENCY = 2; // Jupiter rate-limits a burst of quotes
const now = () => Math.floor(Date.now() / 1000);
const round2 = (n: number) => Math.round(n * 100) / 100;
const day = (t: number) =>
  new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

const basket = (id: string) => {
  const b = BASKETS.find((x) => x.id === id);
  if (!b) throw notFound("basket");
  return b;
};

// The token behind each ticker, deepest pool wins; a ticker we no longer list is left out.
async function resolve(sql: Sql) {
  const rows = await stocksRepo.all(sql);
  const by = new Map(rows.map((r) => [r.underlying ?? r.symbol, r]));
  return (b: Basket) =>
    b.stocks.flatMap((s) => {
      const r = by.get(s.ticker);
      return r ? [{ ...s, row: r }] : [];
    });
}

type Close = { ticker: string; ts: string; close: number };
type Point = { t: number; value: number };

// $100 at equal weight on the first day every stock has a close (or `from`, if later), held to the last close.
// Days a market was shut carry the previous close forward.
function backtest(tickers: string[], rows: Close[], from = 0) {
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
    const value = tickers.reduce((s, t) => s + last.get(t)! / base.get(t)!, 0) * (100 / tickers.length);
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
    basketsRepo.closes(sql, [...new Set(BASKETS.flatMap(tickersOf))], now() - YEAR_S),
  ]);
  return {
    baskets: BASKETS.map((b) => {
      const stocks = pick(b);
      return card(
        b,
        stocks,
        backtest(
          stocks.map((s) => s.ticker),
          closes,
        ),
      );
    }),
    asOf: now(),
  };
}

export async function basketDetail(sql: Sql, id: string) {
  const b = basket(id);
  const [pick, closes] = await Promise.all([
    resolve(sql),
    basketsRepo.closes(sql, [...tickersOf(b), BENCHMARK], now() - YEAR_S),
  ]);
  const stocks = pick(b);
  const bt = backtest(
    stocks.map((s) => s.ticker),
    closes,
  );
  const bench = bt ? backtest([BENCHMARK], closes, bt.points[0]!.t) : null;
  const ranked = bt ? [...bt.byTicker].sort((x, y) => y[1] - x[1]) : [];
  const open = marketOpen();
  return {
    ...card(b, stocks, bt),
    description: b.description,
    about: b.about,
    feeBps: 100,
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
    risk: bt ? risk(bt.points, !!b.private) : null,
    rebalance: {
      available: false,
      note: "Equal weights, set when you buy. Auto-rebalancing is coming soon.",
    },
    best: ranked[0] ? { symbol: ranked[0][0], return1y: ranked[0][1] } : null,
    worst: ranked.at(-1) ? { symbol: ranked.at(-1)![0], return1y: ranked.at(-1)![1] } : null,
    stocks: stocks.map((s) => ({
      weight: round2(100 / stocks.length),
      return1y: bt?.byTicker.get(s.ticker) ?? null,
      why: s.why,
      links: {
        issuer: ISSUER_URL[s.row.issuer] ?? null,
        solscan: `https://solscan.io/token/${s.row.mint}`,
        yahoo: b.private
          ? null
          : `https://finance.yahoo.com/quote/${encodeURIComponent(YAHOO[s.ticker] ?? s.ticker)}`,
      },
      stock: shapeStock(s.row, open),
    })),
  };
}

// The basket's own news: only stories tagged to its stocks, newest first, a few per stock.
export async function basketNews(sql: Sql, id: string, limit: number) {
  const stocks = (await resolve(sql))(basket(id));
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
    } else if ((h.sold += BigInt(l.in_raw)) >= h.bought) m.delete(mint);
  }
  return out;
}

export async function basketPositions(sql: Sql, userId: string) {
  const legs = await basketsRepo.legs(sql, userId);
  const held = holdings(legs);
  const mints = [...new Set([...held.values()].flatMap((m) => [...m.keys()]))];
  const [found, sp] = mints.length
    ? await Promise.all([stocksRepo.byMints(sql, mints), sparks(sql, mints)])
    : [[], new Map<string, Spark>()];
  const rows = new Map(found.map((r) => [r.mint, r]));
  const positions = [...held].flatMap(([basketId, m]) => {
    const parts = [...m].map(([mint, h]) => {
      const r = rows.get(mint);
      const left = h.bought - h.sold;
      const amount = r ? (Number(left) / 10 ** r.decimals) * Number(r.multiplier ?? 1) : 0;
      const stock = {
        mint,
        symbol: r?.symbol ?? null,
        logo: r?.logo ?? null,
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
        name: BASKETS.find((b) => b.id === basketId)?.name ?? basketId,
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

type Ctx = { env: Env; sql: Sql; user: UserRow; wallets: WalletRow[]; settings: SettingsRow };

// One basket order, one swap quote per stock. A stock that will not quote fails the whole order, by name.
async function quoteLegs(
  c: Ctx,
  basketId: string,
  side: "buy" | "sell",
  taker: string,
  amountUsd: number,
  legs: { mint: string; symbol: string; amount: bigint; weight: number }[],
  existing?: string, // a retry adds legs to the order it is finishing
) {
  const orderId = existing ?? crypto.randomUUID();
  if (!existing)
    await basketsRepo.insertOrder(c.sql, {
      id: orderId,
      userId: c.user.id,
      wallet: taker,
      basketId,
      side,
      amountUsd,
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

export async function quoteBuy(c: Ctx, id: string, amountUsd: number, taker: string) {
  const b = basket(id);
  if (amountUsd < MIN_USD) throw new HttpError(400, "below_minimum", { minUsd: MIN_USD });
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
  const stocks = (await resolve(c.sql))(b);
  if (!stocks.length) throw new HttpError(409, "basket_unavailable");
  const each = BigInt(Math.floor((amountUsd * 1e6) / stocks.length));
  return quoteLegs(
    c,
    b.id,
    "buy",
    taker,
    amountUsd,
    stocks.map((s) => ({
      mint: s.row.mint,
      symbol: s.row.symbol,
      amount: each,
      weight: round2(100 / stocks.length),
    })),
  );
}

// Sells everything this wallet's position in the basket holds, never more than the wallet still has on chain.
export async function quoteSell(c: Ctx, id: string, taker: string) {
  const b = basket(id);
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
  if (!(await basketsRepo.order(sql, orderId, user.id)).length) throw notFound("basket order");
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
  const stocks = new Set(legs.map(stockOf)).size;
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
      weight: round2(100 / stocks),
    })),
    orderId,
  );
}
