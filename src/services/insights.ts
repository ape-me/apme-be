import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { stocksRepo } from "../repos/stocks";
import { notFound } from "../lib/errors";

// NASDAQ ticker for a listed stock: xStocks are <TICKER>x, Backpack mostly plain, pre-IPO has none.
export const tickerOf = (s: { symbol: string; issuer: string }) =>
  s.issuer === "prestocks"
    ? null
    : s.issuer === "xstocks"
      ? s.symbol.replace(/x$/i, "")
      : /^[A-Z]{1,5}$/.test(s.symbol)
        ? s.symbol
        : null;

const fh = async <T>(env: Env, path: string): Promise<T | null> => {
  if (!env.FINNHUB_KEY) return null;
  const r = await fetch(`https://finnhub.io/api/v1/${path}&token=${env.FINNHUB_KEY}`);
  return r.ok ? ((await r.json()) as T) : null;
};

type Quote = { c: number; d: number; dp: number; h: number; l: number; o: number; pc: number; t: number };
type Profile = {
  name: string;
  finnhubIndustry: string;
  marketCapitalization: number;
  weburl: string;
  ipo: string;
  exchange: string;
  logo: string;
};
type Metric = { metric: Record<string, number | null> };
type Status = { isOpen: boolean; session: string | null; holiday: string | null };
// Finnhub's session strings vary ("pre-market", "regular", "post-market", null when shut); the app gets four.
const SESSION: Record<string, "pre" | "open" | "post" | "closed"> = {
  "pre-market": "pre",
  premarket: "pre",
  regular: "open",
  open: "open",
  "post-market": "post",
  postmarket: "post",
  "after-hours": "post",
  closed: "closed",
};
type Earnings = {
  earningsCalendar: {
    date: string;
    hour: string;
    epsEstimate: number | null;
    quarter: number;
    year: number;
  }[];
};

const num = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? null : v);
const day = 86400;

// The brokerage half of a stock page: where NASDAQ closed, what the company is worth, when it reports next.
// On-chain price, premium and liquidity stay on /v1/stocks/:mint; this never touches the chain.
export async function insights(env: Env, sql: Sql, mint: string) {
  const stock = await stocksRepo.byMint(sql, mint);
  if (!stock) throw notFound("stock");
  const ticker = tickerOf(stock);
  const today = new Date(),
    in90 = new Date(Date.now() + 90 * day * 1000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const [quote, profile, metrics, status, earnings] = await Promise.all([
    ticker ? fh<Quote>(env, `quote?symbol=${ticker}`) : null,
    ticker ? fh<Profile>(env, `stock/profile2?symbol=${ticker}`) : null,
    ticker ? fh<Metric>(env, `stock/metric?symbol=${ticker}&metric=all`) : null,
    fh<Status>(env, "stock/market-status?exchange=US"),
    ticker ? fh<Earnings>(env, `calendar/earnings?symbol=${ticker}&from=${d(today)}&to=${d(in90)}`) : null,
  ]);
  const m = metrics?.metric ?? {};
  const next = earnings?.earningsCalendar?.[0] ?? null;
  const onChain = num(stock.price_usd);
  const last = num(quote?.c);
  return {
    mint,
    symbol: stock.symbol,
    ticker,
    market: {
      isOpen: status?.isOpen ?? null,
      session: status
        ? (SESSION[(status.session ?? "").toLowerCase()] ?? (status.isOpen ? "open" : "closed"))
        : null,
      rawSession: status?.session ?? null,
      holiday: status?.holiday ?? null,
      // "trades 24/7 here" is the point of the token: always say it, whatever the exchange is doing.
      alwaysOn: true,
    },
    nasdaq: quote
      ? {
          last,
          change: num(quote.d),
          changePct: num(quote.dp),
          open: num(quote.o),
          high: num(quote.h),
          low: num(quote.l),
          prevClose: num(quote.pc),
          asOf: quote.t,
        }
      : null,
    // Premium against the last NASDAQ print, not the indexer's mark: this is the number a user can verify.
    // priceUsd is already per displayed unit, so the scaled-UI multiplier must not be applied again here.
    premiumVsLastPct:
      last && onChain ? Math.round(((onChain / last - 1) * 100 + Number.EPSILON) * 100) / 100 : null,
    stats: ticker
      ? {
          high52w: num(m["52WeekHigh"]),
          low52w: num(m["52WeekLow"]),
          marketCapUsd: profile?.marketCapitalization ? Math.round(profile.marketCapitalization * 1e6) : null,
          peTtm: num(m.peTTM),
          epsTtm: num(m.epsTTM),
          dividendYieldPct: num(m.dividendYieldIndicatedAnnual),
          beta: num(m.beta),
        }
      : null,
    // xStocks pay dividends by rebasing: the custodian reinvests and raises the on-chain multiplier, so the
    // holder's balance grows. Other issuers have no such mechanism, so their yield number means nothing here.
    dividends:
      stock.issuer === "xstocks"
        ? {
            mechanism: "rebase" as const,
            yieldPct: num(m.dividendYieldIndicatedAnnual),
            multiplier: Number(stock.multiplier ?? 1),
            growthSinceLaunchPct: Math.round((Number(stock.multiplier ?? 1) - 1) * 10000) / 100,
          }
        : { mechanism: null, yieldPct: null, multiplier: 1, growthSinceLaunchPct: 0 },
    company: profile
      ? {
          name: profile.name,
          sector: profile.finnhubIndustry,
          exchange: profile.exchange,
          website: profile.weburl,
          ipo: profile.ipo || null,
          logo: profile.logo || null,
        }
      : null,
    earnings: next
      ? {
          date: next.date,
          when: next.hour === "amc" ? "after close" : next.hour === "bmo" ? "before open" : null,
          inDays: Math.round((Date.parse(next.date) - Date.now()) / (day * 1000)),
          epsEstimate: num(next.epsEstimate),
          quarter: next.quarter,
          year: next.year,
        }
      : null,
    asOf: Math.floor(Date.now() / 1000),
  };
}
