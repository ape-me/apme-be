import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { tokenAccounts } from "../lib/rpc";
import { stocksRepo, type StockRow } from "../repos/stocks";
import { basketsRepo, type BasketLeg } from "../repos/baskets";
import type { UserRow, WalletRow, SettingsRow } from "../repos/account";
import { shapeStock, marketOpen, tradable } from "./shape";
import { quote, submit } from "./swap";

// Ready-made baskets, equal weight. Stocks are real-world tickers so each resolves to its deepest token at request
// time. `private` ones have no exchange closes; their chart comes from our own price snapshots.
export const BASKETS: readonly {
  id: string;
  name: string;
  tagline: string;
  description: string;
  tickers: readonly string[];
  private?: boolean;
}[] = [
  {
    id: "mag7",
    name: "Mag 7",
    tagline: "The 7 biggest US tech companies",
    description: "Apple, Microsoft, Google, Amazon, Meta, Nvidia and Tesla in one buy.",
    tickers: ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA"],
  },
  {
    id: "chips",
    name: "Chip Kings",
    tagline: "The chips and memory AI runs on",
    description: "Nvidia, Micron, SK Hynix, AMD, Sandisk and Intel: whoever builds AI has to buy from them.",
    tickers: ["NVDA", "MU", "SKHY", "AMD", "SNDK", "INTC"],
  },
  {
    id: "crypto",
    name: "Crypto Wall St",
    tagline: "Public companies that live on crypto",
    description: "Coinbase, Robinhood, Strategy and Circle: listed companies that rise and fall with crypto.",
    tickers: ["COIN", "HOOD", "MSTR", "CRCL"],
  },
  {
    id: "preipo",
    name: "Before They IPO",
    tagline: "Private giants, before the IPO",
    description:
      "OpenAI, Anthropic, SpaceX, Anduril, Neuralink and Polymarket: not on any stock exchange yet.",
    tickers: ["OPENAI", "ANTHROPIC", "SPACEX", "ANDURIL", "NEURALINK", "POLYMARKET"],
    private: true,
  },
  {
    id: "market",
    name: "Index & Chill",
    tagline: "The whole US market and Buffett",
    description: "The S&P 500, the Nasdaq 100 and Berkshire Hathaway.",
    tickers: ["SPY", "QQQ", "BRK.B"],
  },
  {
    id: "real",
    name: "Real Stuff",
    tagline: "Gold, oil, copper, uranium",
    description: "Gold, oil, copper miners and uranium: things you can dig up or burn.",
    tickers: ["GLD", "USO", "COPX", "URA"],
  },
  {
    id: "brands",
    name: "Main Street",
    tagline: "Brands people use every day",
    description: "Nike, Netflix, Costco, Ferrari and Take-Two.",
    tickers: ["NKE", "NFLX", "COST", "RACE", "TTWO"],
  },
  {
    id: "retail",
    name: "Retail Army",
    tagline: "What retail traders pile into",
    description: "Palantir, GameStop, Trump Media and Hims & Hers.",
    tickers: ["PLTR", "GME", "DJT", "HIMS"],
  },
];

const MIN_USD = 10;
const YEAR_S = 366 * 86400;
const QUOTE_CONCURRENCY = 2; // Jupiter rate-limits a burst of quotes
const now = () => Math.floor(Date.now() / 1000);
const round2 = (n: number) => Math.round(n * 100) / 100;

const basket = (id: string) => {
  const b = BASKETS.find((x) => x.id === id);
  if (!b) throw notFound("basket");
  return b;
};

// The token behind each ticker, deepest pool wins; a ticker we no longer list is left out.
async function resolve(sql: Sql) {
  const rows = await stocksRepo.all(sql);
  const by = new Map(rows.map((r) => [r.underlying ?? r.symbol, r]));
  return (tickers: readonly string[]) =>
    tickers.flatMap((t) => {
      const r = by.get(t);
      return r ? [{ ticker: t, row: r }] : [];
    });
}

// $100 at equal weight on the first day every stock has a close, held to the last close. Days a market was shut
// carry the previous close forward.
function backtest(tickers: string[], rows: { ticker: string; ts: string; close: number }[]) {
  const mine = rows.filter((r) => tickers.includes(r.ticker));
  const first = new Map<string, number>();
  for (const r of mine) if (!first.has(r.ticker)) first.set(r.ticker, Number(r.ts));
  if (!tickers.length || tickers.some((t) => !first.has(t))) return null;
  const start = Math.max(...first.values());
  const last = new Map<string, number>();
  const base = new Map<string, number>();
  const points: { t: number; value: number }[] = [];
  const days = [...new Set(mine.map((r) => Number(r.ts)))];
  let i = 0;
  for (const day of days) {
    for (; i < mine.length && Number(mine[i]!.ts) === day; i++) last.set(mine[i]!.ticker, mine[i]!.close);
    if (day < start) continue;
    if (!base.size) for (const t of tickers) base.set(t, last.get(t)!);
    const value = tickers.reduce((s, t) => s + last.get(t)! / base.get(t)!, 0) * (100 / tickers.length);
    points.push({ t: day, value: round2(value) });
  }
  const end = points.at(-1)!.t;
  return {
    points,
    returnPct: round2(points.at(-1)!.value - 100),
    returnLabel:
      end - start >= 350 * 86400
        ? "1Y"
        : `since ${new Date(start * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}`,
    byTicker: new Map(tickers.map((t) => [t, round2((last.get(t)! / base.get(t)! - 1) * 100)])),
  };
}

const card = (b: (typeof BASKETS)[number], stocks: { row: StockRow }[], bt: ReturnType<typeof backtest>) => ({
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
    basketsRepo.closes(sql, [...new Set(BASKETS.flatMap((b) => b.tickers))], now() - YEAR_S),
  ]);
  return {
    baskets: BASKETS.map((b) => {
      const stocks = pick(b.tickers);
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
  const pick = await resolve(sql);
  const stocks = pick(b.tickers);
  const bt = backtest(
    stocks.map((s) => s.ticker),
    await basketsRepo.closes(sql, b.tickers, now() - YEAR_S),
  );
  const ranked = bt ? [...bt.byTicker].sort((x, y) => y[1] - x[1]) : [];
  const open = marketOpen();
  return {
    ...card(b, stocks, bt),
    description: b.description,
    feeBps: 100,
    chart: bt ? { range: bt.returnLabel, points: bt.points } : null,
    best: ranked[0] ? { symbol: ranked[0][0], return1y: ranked[0][1] } : null,
    worst: ranked.at(-1) ? { symbol: ranked.at(-1)![0], return1y: ranked.at(-1)![1] } : null,
    stocks: stocks.map((s) => ({
      weight: round2(100 / stocks.length),
      return1y: bt?.byTicker.get(s.ticker) ?? null,
      stock: shapeStock(s.row, open),
    })),
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
  const held = holdings(await basketsRepo.legs(sql, userId));
  const mints = [...new Set([...held.values()].flatMap((m) => [...m.keys()]))];
  const rows = new Map(mints.length ? (await stocksRepo.byMints(sql, mints)).map((r) => [r.mint, r]) : []);
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
      return { stock, paid: (h.cost * Number(left)) / Number(h.bought), opened: h.opened };
    });
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
) {
  const orderId = crypto.randomUUID();
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
              c.settings,
              { ...mints, amount: l.amount.toString(), taker },
              orderId,
            ).catch((e: Error) => {
              throw new HttpError(e instanceof HttpError ? e.status : 500, `${l.symbol}: ${e.message}`, {
                symbol: l.symbol,
              });
            });
            return { weight: l.weight, ...q };
          }),
        )),
      );
  } catch (e) {
    await basketsRepo.setStatus(c.sql, orderId, "failed");
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
  const stocks = (await resolve(c.sql))(b.tickers);
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
    const amount = left < (onChain.get(mint) ?? 0n) ? left : (onChain.get(mint) ?? 0n);
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

// Every signed leg goes out at once; the order is done, partial or failed by how many landed.
export async function submitBasket(
  env: Env,
  sql: Sql,
  user: UserRow,
  orderId: string,
  signed: { requestId: string; signedTransaction: string }[],
) {
  if (!(await basketsRepo.order(sql, orderId, user.id)).length) throw notFound("basket order");
  const ids = new Set((await basketsRepo.legIds(sql, orderId)).map((r) => r.id));
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
  const ok = legs.filter((l) => l.status === "confirmed").length;
  const status = ok === ids.size ? "done" : ok ? "partial" : "failed";
  await basketsRepo.setStatus(sql, orderId, status);
  return { orderId, status, legs };
}
