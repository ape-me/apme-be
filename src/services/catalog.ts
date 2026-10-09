import type { Sql } from "../lib/db";
import { stocksRepo, type Category } from "../repos/stocks";
import { tickerRepo } from "../repos/ticker";
import { notFound } from "../lib/errors";
import { shapeStock, marketSession } from "./shape";
import { sparks } from "./spark";
import { COLLECTIONS, filterCollection } from "./collections";
import type { StocksResponse, TickerResponse, CollectionsResponse, MoversResponse } from "../contract";
import type { z } from "zod";

const market = () => {
  const session = marketSession();
  return { session, isOpen: session === "open" };
};

const MOVER_MIN_LIQUIDITY = 20_000;
const MOVER_MAX_PREMIUM = 15; // percent off the real price
const MOVER_DEEP_LIQUIDITY = 500_000; // trusted without a mark

export const catalog = {
  ticker: async (sql: Sql, stonks: number): Promise<z.infer<typeof TickerResponse>> => {
    const rows = await tickerRepo.rows(sql, stonks);
    return {
      updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      tokens: rows.map((r) => ({
        id: r.id,
        label: r.label,
        logo: r.logo,
        change24h: r.change24h == null ? null : Number(r.change24h),
        price: r.price == null ? null : Number(r.price),
      })),
    };
  },

  stocks: async (
    sql: Sql,
    issuers?: string[],
    collection?: string,
    category?: Category,
  ): Promise<z.infer<typeof StocksResponse>> => {
    const m = market();
    const rows = await stocksRepo.all(sql, category);
    let keep = issuers?.length ? rows.filter((r) => issuers.includes(r.issuer)) : rows; // ~100 rows, cheaper than a second query plan
    if (collection) keep = filterCollection(keep, collection);
    const sp = await sparks(
      sql,
      keep.map((r) => r.mint),
    );
    return {
      stocks: keep.map((r) => shapeStock(r, m.isOpen, sp.get(r.mint))),
      market: m,
      asOf: Math.floor(Date.now() / 1000),
    };
  },
  // Home screen groups. Hand-picked by symbol so the app never hard-codes a list; a symbol the DB doesn't have is skipped.
  collections: async (sql: Sql): Promise<z.infer<typeof CollectionsResponse>> => {
    const m = market();
    const rows = await stocksRepo.all(sql);
    const sp = await sparks(
      sql,
      rows.map((r) => r.mint),
    );
    const byUnder = new Map(rows.map((r) => [r.underlying ?? r.symbol, r]));
    const pick = (unders: readonly string[]) =>
      unders.map((x) => byUnder.get(x)).filter((r): r is NonNullable<typeof r> => !!r);
    const collections = COLLECTIONS.map((c) => ({
      id: c.id,
      title: c.title,
      tagline: c.tagline,
      stocks: (c.underlyings ? pick(c.underlyings) : filterCollection(rows, c.id)) // hand-picked order
        .map((r) => shapeStock(r, m.isOpen, sp.get(r.mint))),
    })).filter((c) => c.stocks.length);
    return { collections, market: m, asOf: Math.floor(Date.now() / 1000) };
  },
  // Gainers / losers / most traded over 24h. A thin pool can print "+170%" on BABA while the real share is flat,
  // so a stock qualifies only when its token tracks the real price (small premium) or is deep enough to trust.
  movers: async (sql: Sql, limit: number): Promise<z.infer<typeof MoversResponse>> => {
    const m = market();
    const rows = (await stocksRepo.all(sql)).filter(
      (r) =>
        r.price_usd != null &&
        (r.liquidity_usd ?? 0) >= MOVER_MIN_LIQUIDITY &&
        (r.premium_pct != null
          ? Math.abs(r.premium_pct) <= MOVER_MAX_PREMIUM
          : (r.liquidity_usd ?? 0) >= MOVER_DEEP_LIQUIDITY),
    );
    const by = (f: (r: (typeof rows)[number]) => number, desc = true) =>
      [...rows].sort((a, b) => (desc ? f(b) - f(a) : f(a) - f(b))).slice(0, limit);
    const lists = {
      gainers: by((r) => r.change_24h ?? 0),
      losers: by((r) => r.change_24h ?? 0, false),
      mostTraded: by((r) => r.vol_24h_usd ?? 0),
    };
    const sp = await sparks(
      sql,
      Object.values(lists).flatMap((l) => l.map((r) => r.mint)),
    );
    const shape = (l: typeof rows) => l.map((r) => shapeStock(r, m.isOpen, sp.get(r.mint)));
    return {
      gainers: shape(lists.gainers),
      losers: shape(lists.losers),
      mostTraded: shape(lists.mostTraded),
      market: m,
      asOf: Math.floor(Date.now() / 1000),
    };
  },
  // Watchlists live on the phone; these return the same shapes for a handful of mints, in request order.
  stocksByMints: async (sql: Sql, mints: string[]): Promise<z.infer<typeof StocksResponse>> => {
    const mkt = market();
    const [rows, sp] = await Promise.all([stocksRepo.byMints(sql, mints), sparks(sql, mints)]);
    const by = new Map(rows.map((r) => [r.mint, r]));
    return {
      stocks: mints
        .map((m) => by.get(m))
        .filter((r): r is NonNullable<typeof r> => !!r)
        .map((r) => shapeStock(r, mkt.isOpen, sp.get(r.mint))),
      market: mkt,
      asOf: Math.floor(Date.now() / 1000),
    };
  },
  stock: async (sql: Sql, mint: string) => {
    const row = await stocksRepo.byMint(sql, mint);
    if (!row) throw notFound("stock");
    return shapeStock(row);
  },

  // Any token list: per stock or global, optional column, filters, sort, cursor. `next` is null on the last page.

  // The whole floor screen in one call: three columns, top `limit` each, same filters applied to all three.
};
