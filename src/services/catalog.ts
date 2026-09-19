import type { Sql } from "../lib/db";
import { stocksRepo } from "../repos/stocks";
import { tokensRepo, defaultSort, type Sort, type Column } from "../repos/tokens";
import { tickerRepo } from "../repos/ticker";
import { notFound } from "../lib/errors";
import { shapeStock, shapeToken, shapeHeader, marketOpen } from "./shape";
import type { StocksResponse, StockTokensResponse, TokenHeader, TickerResponse, TokensResponse, FloorResponse, TokenFilters, CollectionsResponse, MoversResponse } from "../contract";
import type { z } from "zod";

const encodeCursor = (v: number, mint: string) => btoa(`${v}:${mint}`);
const decodeCursor = (c?: string) => {
  if (!c) return undefined;
  try { const [v, mint] = atob(c).split(":"); return v && mint ? { v: Number(v), mint } : undefined; } catch { return undefined; }
};

const MOVER_MIN_LIQUIDITY = 20_000;
const MOVER_MAX_PREMIUM = 15;          // percent off the real price
const MOVER_DEEP_LIQUIDITY = 500_000;  // trusted without a mark

// Order matters: this is the order the home screen shows them.
const COLLECTIONS: readonly { id: string; title: string; tagline: string; issuer?: string; category?: string; symbols?: readonly string[] }[] = [
  { id: "preipo", title: "Pre-IPO", tagline: "Private companies, before the IPO", issuer: "prestocks" },
  { id: "ai", title: "AI", tagline: "The models and the chips behind them", symbols: ["OPENAI", "ANTHROPIC", "NVDAX", "AMD", "MU", "PLTRX", "NBIS", "MRVL", "SKHY", "SNDK", "DRAM", "FIGUREAI", "NEURALINK", "QUBT"] },
  { id: "mag7", title: "Big Tech", tagline: "The seven that move the market", symbols: ["APPLX", "MSFTX", "NVDAX", "AMZNX", "GOOGLX", "METAX", "TSLAX"] },
  { id: "crypto-stocks", title: "Crypto stocks", tagline: "Public companies that live on crypto", symbols: ["COINX", "CRCLX", "HOODX", "MSTRX", "STRCX", "WULF", "DFDV", "VIDAX"] },
  { id: "memestocks", title: "Meme stocks", tagline: "The originals", symbols: ["GMEX", "AMC", "DJT", "BB", "RUM", "WEBULL", "RBLX", "SNAP"] },
  { id: "prediction", title: "Bets & markets", tagline: "Prediction markets, sportsbooks, casinos", symbols: ["KALSHI", "POLYMARKET", "DKNG", "MGM"] },
  { id: "defense", title: "Defense & space", tagline: "Hardware for hard times", symbols: ["ANDURIL", "LMT", "BOEING"] },
  { id: "health", title: "Health", tagline: "Pharma and care", symbols: ["LLY", "JNJ", "PFIZER", "MRNA", "HIMS"] },
  { id: "etf", title: "ETFs & commodities", tagline: "Whole markets in one token", category: "etf" },
];

export const catalog = {
  ticker: async (sql: Sql, stonks: number, memes: number): Promise<z.infer<typeof TickerResponse>> => {
    const rows = await tickerRepo.rows(sql, stonks, memes);
    const memesFirst = [...rows.filter((r) => r.kind === "meme"), ...rows.filter((r) => r.kind === "stonk")];
    return {
      updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      tokens: memesFirst.map((r) => ({ id: r.id, kind: r.kind, label: r.label, logo: r.logo, change24h: r.change24h == null ? null : Number(r.change24h), price: r.price == null ? null : Number(r.price) })),
    };
  },

  stocks: async (sql: Sql, issuers?: string[]): Promise<z.infer<typeof StocksResponse>> => {
    const open = marketOpen();
    const rows = await stocksRepo.all(sql);
    const keep = issuers?.length ? rows.filter((r) => issuers.includes(r.issuer)) : rows;   // 94 rows, cheaper than a second query plan
    return { stocks: keep.map((r) => shapeStock(r, open)), asOf: Math.floor(Date.now() / 1000) };
  },
  // Home screen groups. Hand-picked by symbol so the app never hard-codes a list; a symbol the DB doesn't have is skipped.
  collections: async (sql: Sql): Promise<z.infer<typeof CollectionsResponse>> => {
    const open = marketOpen();
    const rows = await stocksRepo.all(sql);
    const bySym = new Map(rows.map((r) => [r.symbol, r]));
    const pick = (syms: readonly string[]) => syms.map((x) => bySym.get(x)).filter((r): r is NonNullable<typeof r> => !!r).map((r) => shapeStock(r, open));
    const collections = COLLECTIONS.map((c) => ({
      id: c.id, title: c.title, tagline: c.tagline,
      stocks: c.issuer ? rows.filter((r) => r.issuer === c.issuer).map((r) => shapeStock(r, open)) : c.category ? rows.filter((r) => r.category === c.category).map((r) => shapeStock(r, open)) : pick(c.symbols ?? []),
    })).filter((c) => c.stocks.length);
    return { collections, asOf: Math.floor(Date.now() / 1000) };
  },
  // Gainers / losers / most traded over 24h. A thin pool can print "+170%" on BABA while the real share is flat,
  // so a stock qualifies only when its token tracks the real price (small premium) or is deep enough to trust.
  movers: async (sql: Sql, limit: number): Promise<z.infer<typeof MoversResponse>> => {
    const open = marketOpen();
    const rows = (await stocksRepo.all(sql)).filter((r) => r.price_usd != null && (r.liquidity_usd ?? 0) >= MOVER_MIN_LIQUIDITY
      && (r.premium_pct != null ? Math.abs(r.premium_pct) <= MOVER_MAX_PREMIUM : (r.liquidity_usd ?? 0) >= MOVER_DEEP_LIQUIDITY));
    const by = (f: (r: (typeof rows)[number]) => number, desc = true) => [...rows].sort((a, b) => (desc ? f(b) - f(a) : f(a) - f(b))).slice(0, limit).map((r) => shapeStock(r, open));
    return {
      gainers: by((r) => r.change_24h ?? 0), losers: by((r) => r.change_24h ?? 0, false),
      mostTraded: by((r) => r.vol_24h_usd ?? 0), asOf: Math.floor(Date.now() / 1000),
    };
  },
  stock: async (sql: Sql, mint: string) => {
    const row = await stocksRepo.byMint(sql, mint);
    if (!row) throw notFound("stock");
    return shapeStock(row);
  },

  // Any token list: per stock or global, optional column, filters, sort, cursor. `next` is null on the last page.
  list: async (sql: Sql, o: { stock?: string; column?: Column; sort?: Sort; limit: number; cursor?: string; filters: TokenFilters }): Promise<z.infer<typeof TokensResponse>> => {
    const sort = o.sort ?? defaultSort(o.column);
    const rows = await tokensRepo.list(sql, { stock: o.stock, column: o.column, sort, limit: o.limit, after: decodeCursor(o.cursor), filters: o.filters });
    const last = rows[rows.length - 1] as (typeof rows)[number] & { sort_v: number } | undefined;
    return { tokens: rows.map(shapeToken), next: rows.length === o.limit && last ? encodeCursor(Number(last.sort_v), last.mint) : null };
  },

  stockTokens: async (sql: Sql, mint: string, o: { column?: Column; sort?: Sort; limit: number; cursor?: string; filters: TokenFilters }): Promise<z.infer<typeof StockTokensResponse>> => {
    const [stock, page] = await Promise.all([stocksRepo.byMint(sql, mint), catalog.list(sql, { ...o, stock: mint })]);
    if (!stock) throw notFound("stock");
    return { stock: shapeStock(stock), tokens: page.tokens, next: page.next };
  },

  // The whole floor screen in one call: three columns, top `limit` each, same filters applied to all three.
  floor: async (sql: Sql, o: { stock?: string; limit: number; filters: TokenFilters }): Promise<z.infer<typeof FloorResponse>> => {
    const col = (column: Column) => catalog.list(sql, { stock: o.stock, column, limit: o.limit, filters: o.filters });
    const [stock, n, g, d] = await Promise.all([o.stock ? stocksRepo.byMint(sql, o.stock) : Promise.resolve(null), col("new"), col("graduating"), col("graduated")]);
    if (o.stock && !stock) throw notFound("stock");
    return { stock: stock ? shapeStock(stock) : null, new: n.tokens, graduating: g.tokens, graduated: d.tokens, asOf: Math.floor(Date.now() / 1000) };
  },

  token: async (sql: Sql, mint: string): Promise<TokenHeader> => {
    const t = await tokensRepo.withStock(sql, mint);
    if (!t) throw notFound("token");
    return shapeHeader(t, t.stock);
  },
};
