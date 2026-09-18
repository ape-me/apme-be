import type { Sql } from "../lib/db";
import { stocksRepo } from "../repos/stocks";
import { tokensRepo, defaultSort, type Sort, type Column } from "../repos/tokens";
import { tickerRepo } from "../repos/ticker";
import { notFound } from "../lib/errors";
import { shapeStock, shapeToken, shapeHeader, marketOpen } from "./shape";
import type { StocksResponse, StockTokensResponse, TokenHeader, TickerResponse, TokensResponse, FloorResponse, TokenFilters } from "../contract";
import type { z } from "zod";

const encodeCursor = (v: number, mint: string) => btoa(`${v}:${mint}`);
const decodeCursor = (c?: string) => {
  if (!c) return undefined;
  try { const [v, mint] = atob(c).split(":"); return v && mint ? { v: Number(v), mint } : undefined; } catch { return undefined; }
};

export const catalog = {
  ticker: async (sql: Sql, stonks: number, memes: number): Promise<z.infer<typeof TickerResponse>> => {
    const rows = await tickerRepo.rows(sql, stonks, memes);
    const memesFirst = [...rows.filter((r) => r.kind === "meme"), ...rows.filter((r) => r.kind === "stonk")];
    return {
      updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      tokens: memesFirst.map((r) => ({ id: r.id, kind: r.kind, label: r.label, logo: r.logo, change24h: r.change24h == null ? null : Number(r.change24h), price: r.price == null ? null : Number(r.price) })),
    };
  },

  stocks: async (sql: Sql): Promise<z.infer<typeof StocksResponse>> => {
    const open = marketOpen();
    const rows = await stocksRepo.all(sql);
    return { stocks: rows.map((r) => shapeStock(r, open)), asOf: Math.floor(Date.now() / 1000) };
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
