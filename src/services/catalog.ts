import type { Sql } from "../lib/db";
import { stocksRepo } from "../repos/stocks";
import { tokensRepo, type Sort } from "../repos/tokens";
import { notFound } from "../lib/errors";
import { shapeStock, shapeToken, shapeHeader, marketOpen } from "./shape";
import type { StocksResponse, StockTokensResponse, TokenHeader } from "../contract";
import type { z } from "zod";

const encodeCursor = (v: number, mint: string) => btoa(`${v}:${mint}`);
const decodeCursor = (c?: string) => {
  if (!c) return undefined;
  try { const [v, mint] = atob(c).split(":"); return v && mint ? { v: Number(v), mint } : undefined; } catch { return undefined; }
};

export const catalog = {
  stocks: async (sql: Sql): Promise<z.infer<typeof StocksResponse>> => {
    const open = marketOpen();
    const rows = await stocksRepo.all(sql);
    return { stocks: rows.map((r) => shapeStock(r, open)), asOf: Math.floor(Date.now() / 1000) };
  },

  stockTokens: async (sql: Sql, mint: string, sort: Sort, limit: number, cursor?: string): Promise<z.infer<typeof StockTokensResponse>> => {
    const [stock, rows] = await Promise.all([stocksRepo.byMint(sql, mint), tokensRepo.byStock(sql, mint, sort, limit, decodeCursor(cursor))]);
    if (!stock) throw notFound("stock");
    const last = rows[rows.length - 1];
    const next = rows.length === limit && last
      ? encodeCursor(sort === "new" ? Number(last.created_at) : sort === "mcap" ? Number(last.mcap_usd ?? 0) : Number(last.vol_24h_usd ?? 0), last.mint)
      : null;
    return { stock: shapeStock(stock), tokens: rows.map(shapeToken), next };
  },

  token: async (sql: Sql, mint: string): Promise<TokenHeader> => {
    const t = await tokensRepo.withStock(sql, mint);
    if (!t) throw notFound("token");
    return shapeHeader(t, t.stock);
  },
};
