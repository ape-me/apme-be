import type { Sql } from "../lib/db";
import type { Env } from "../env";
import { walletRepo } from "../repos/wallet";
import { balances, solPrice, SOL_MINT } from "../lib/rpc";
import type { WalletResponse } from "../contract";
import type { z } from "zod";

const round = (v: number | null | undefined, d = 2) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);

// One screen: what the wallet holds (chain), what it paid (our tape), what it's worth (current prices).
export async function wallet(env: Env, sql: Sql, address: string, activityLimit: number): Promise<z.infer<typeof WalletResponse>> {
  const [{ sol, tokens }, solUsdPrice, positions, activityRows] = await Promise.all([
    balances(env, address), solPrice(), walletRepo.positions(sql, address), walletRepo.activity(sql, address, activityLimit),
  ]);
  const mints = tokens.map((t) => t.mint);
  const known = mints.length ? await walletRepo.known(sql, mints) : [];
  const meta = new Map(known.map((k) => [k.mint, k]));
  const pos = new Map(positions.map((p) => [p.token_mint, p]));

  const holdings: z.infer<typeof WalletResponse>["holdings"] = [];
  const solUsd = solUsdPrice == null ? 0 : sol * solUsdPrice;
  if (sol > 0) holdings.push({ mint: SOL_MINT, kind: "sol", symbol: "SOL", name: "Solana", image: null, quoteSymbol: null, amount: sol, priceUsd: round(solUsdPrice), valueUsd: round(solUsd), change24h: null, costUsd: null, pnlUsd: null, pnlPct: null });

  let stocksUsd = 0, memesUsd = 0, costUsd = 0, pnlUsd = 0, realizedUsd = 0;
  for (const t of tokens) {
    const m = meta.get(t.mint);
    if (!m) continue;                                             // not a stock or a meme we index: hidden, not our business
    const value = m.price_usd == null ? null : t.amount * m.price_usd;
    if (m.kind === "stock") stocksUsd += value ?? 0; else memesUsd += value ?? 0;
    // Cost basis: average price paid across every buy on our tape, applied to what is still held.
    const p = pos.get(t.mint);
    let cost: number | null = null, pnl: number | null = null, pnlPct: number | null = null;
    if (p && Number(p.bought_raw) > 0) {
      const boughtAmt = Number(p.bought_raw) / 10 ** m.decimals;
      const avg = p.bought_usd / boughtAmt;
      cost = avg * t.amount;
      costUsd += cost;
      if (value != null) { pnl = value - cost; pnlUsd += pnl; pnlPct = cost > 0 ? (pnl / cost) * 100 : null; }
      realizedUsd += p.sold_usd - avg * (Number(p.sold_raw) / 10 ** m.decimals);
    }
    holdings.push({
      mint: t.mint, kind: m.kind, symbol: m.symbol, name: m.name, image: m.image, quoteSymbol: m.quote_symbol,
      amount: t.amount, priceUsd: m.price_usd, valueUsd: round(value), change24h: m.change_24h,
      costUsd: round(cost), pnlUsd: round(pnl), pnlPct: round(pnlPct),
    });
  }
  holdings.sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0));

  const activity = activityRows.map((r) => {
    const quote = Number(r.quote_raw) / 10 ** r.quote_decimals;
    return {
      sig: r.signature, ts: Number(r.block_time), side: r.side, mint: r.token_mint, symbol: r.symbol, image: r.image, stockSymbol: r.stock_symbol,
      amount: Number(r.base_raw) / 10 ** r.decimals, quote, usd: round(quote * (r.quote_usd ?? r.stock_price_usd ?? NaN)) ?? null,
    };
  }).map((a) => ({ ...a, usd: Number.isFinite(a.usd as number) ? a.usd : null }));

  return {
    address, totalUsd: round(solUsd + stocksUsd + memesUsd)!, solUsd: round(solUsd)!, stocksUsd: round(stocksUsd)!, memesUsd: round(memesUsd)!,
    costUsd: round(costUsd)!, pnlUsd: round(pnlUsd)!, realizedUsd: round(realizedUsd)!, holdings, activity, asOf: Math.floor(Date.now() / 1000),
  };
}
