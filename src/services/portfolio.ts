import type { Sql } from "../lib/db";
import type { Env } from "../env";
import { walletRepo } from "../repos/wallet";
import { balances, solPrice, usdcTransfers, SOL_MINT, USDC_MINT } from "../lib/rpc";
import { ata } from "../lib/solana";
import { txStatus } from "./swap";
import { swapAct, depositAct, tradeAct, USDC_LOGO, type Act } from "./activity";
import { PublicKey } from "@solana/web3.js";
import type { WalletResponse } from "../contract";
import type { z } from "zod";

const SOL_LOGO =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png";

const round = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

// Holdings from chain, cost basis from our swaps + indexed trades, activity from swaps + deposits + trades.
export async function wallet(
  env: Env,
  sql: Sql,
  address: string,
  activityLimit: number,
): Promise<z.infer<typeof WalletResponse>> {
  const usdcAta = ata(new PublicKey(address), new PublicKey(USDC_MINT)).toBase58();
  const [{ sol, tokens }, solUsdPrice, tradePositions, tradeRows, swapPositions, swapRows, transfers] =
    await Promise.all([
      balances(env, address),
      solPrice(),
      walletRepo.positions(sql, address),
      walletRepo.activity(sql, address, activityLimit),
      walletRepo.swapPositions(sql, address),
      walletRepo.swapActivity(sql, address, activityLimit),
      usdcTransfers(env, usdcAta).catch(() => []),
    ]);
  if (transfers.length) await walletRepo.saveDeposits(sql, address, transfers).catch(() => {});
  // Rows still "submitted" only flip when /v1/tx is polled; settle them here so pendingSwaps is honest.
  const settled = await Promise.all(
    swapRows
      .filter((r) => r.status === "submitted" && r.signature)
      .map((r) => txStatus(env, sql, r.signature!).catch(() => null)),
  );
  for (const r of swapRows) {
    const st = settled.find((x) => x?.signature === r.signature);
    if (st && st.status !== "pending") r.status = st.status;
  }
  const mints = [
    ...new Set([
      ...tokens.map((t) => t.mint),
      ...swapRows.map((r) => (r.side === "buy" ? r.output_mint : r.input_mint)),
    ]),
  ].filter((m) => m !== USDC_MINT);
  const known = mints.length ? await walletRepo.known(sql, mints) : [];
  const meta = new Map(known.map((k) => [k.mint, k]));

  // Cost basis per mint: our swaps (stocks and memes) + indexer trades (memes bought on the floor elsewhere).
  const basis = new Map<
    string,
    { boughtRaw: number; boughtUsd: number; soldRaw: number; soldUsd: number; feesUsd: number }
  >();
  const add = (
    mint: string,
    b: { boughtRaw: number; boughtUsd: number; soldRaw: number; soldUsd: number; feesUsd: number },
  ) => {
    const cur = basis.get(mint) ?? { boughtRaw: 0, boughtUsd: 0, soldRaw: 0, soldUsd: 0, feesUsd: 0 };
    basis.set(mint, {
      boughtRaw: cur.boughtRaw + b.boughtRaw,
      boughtUsd: cur.boughtUsd + b.boughtUsd,
      soldRaw: cur.soldRaw + b.soldRaw,
      soldUsd: cur.soldUsd + b.soldUsd,
      feesUsd: cur.feesUsd + b.feesUsd,
    });
  };
  for (const p of tradePositions)
    add(p.token_mint, {
      boughtRaw: Number(p.bought_raw),
      boughtUsd: p.bought_usd,
      soldRaw: Number(p.sold_raw),
      soldUsd: p.sold_usd,
      feesUsd: 0,
    });
  for (const p of swapPositions)
    add(p.mint, {
      boughtRaw: Number(p.bought_raw),
      boughtUsd: Number(p.bought_usd),
      soldRaw: Number(p.sold_raw),
      soldUsd: Number(p.sold_usd),
      feesUsd: Number(p.fees_usd),
    });

  const holdings: z.infer<typeof WalletResponse>["holdings"] = [];
  const usdc = tokens.find((t) => t.mint === USDC_MINT);
  const cashUsd = usdc?.amount ?? 0;
  holdings.push({
    mint: USDC_MINT,
    kind: "cash",
    symbol: "USDC",
    name: "Cash",
    image: USDC_LOGO,
    quoteSymbol: null,
    amount: cashUsd,
    raw: usdc?.raw ?? "0",
    decimals: 6,
    priceUsd: 1,
    valueUsd: round(cashUsd),
    change24h: null,
    costUsd: null,
    avgEntryUsd: null,
    feesUsd: 0,
    pnlUsd: null,
    pnlPct: null,
  });
  const solUsd = solUsdPrice == null ? 0 : sol * solUsdPrice;
  if (sol > 0)
    holdings.push({
      mint: SOL_MINT,
      kind: "sol",
      symbol: "SOL",
      name: "Solana",
      image: SOL_LOGO,
      quoteSymbol: null,
      amount: sol,
      raw: String(Math.round(sol * 1e9)),
      decimals: 9,
      priceUsd: round(solUsdPrice),
      valueUsd: round(solUsd),
      change24h: null,
      costUsd: null,
      avgEntryUsd: null,
      feesUsd: 0,
      pnlUsd: null,
      pnlPct: null,
    });

  let stocksUsd = 0,
    memesUsd = 0,
    costUsd = 0,
    feesUsd = 0,
    pnlUsd = 0,
    realizedUsd = 0;
  for (const t of tokens) {
    const m = meta.get(t.mint);
    if (!m) continue; // not a stock or a meme we index: hidden, not our business
    // Displayed units from raw: RPC uiAmount is inconsistent about the scaled-UI multiplier, so never use it.
    const amount = (Number(t.raw) / 10 ** t.decimals) * (m.kind === "stock" ? Number(m.multiplier ?? 1) : 1);
    const value = m.price_usd == null ? null : amount * m.price_usd;
    if (m.kind === "stock") stocksUsd += value ?? 0;
    else memesUsd += value ?? 0;
    // Cost = what actually bought tokens (fees excluded), averaged per raw unit over every buy we know of.
    const b = basis.get(t.mint);
    let cost: number | null = null,
      avgEntry: number | null = null,
      pnl: number | null = null,
      pnlPct: number | null = null;
    feesUsd += b?.feesUsd ?? 0;
    if (b && b.boughtRaw > 0) {
      const avgPerRaw = b.boughtUsd / b.boughtRaw;
      cost = avgPerRaw * Number(t.raw);
      avgEntry = cost / amount;
      costUsd += cost;
      if (value != null) {
        pnl = value - cost;
        pnlUsd += pnl;
        pnlPct = cost > 0 ? (pnl / cost) * 100 : null;
      }
      realizedUsd += b.soldUsd - avgPerRaw * b.soldRaw;
    }
    holdings.push({
      mint: t.mint,
      kind: m.kind,
      symbol: m.symbol,
      name: m.name,
      image: m.image,
      quoteSymbol: m.quote_symbol,
      amount,
      raw: t.raw,
      decimals: t.decimals,
      priceUsd: m.price_usd,
      valueUsd: round(value),
      change24h: m.change_24h,
      costUsd: round(cost),
      avgEntryUsd: round(avgEntry, 4),
      feesUsd: round(b?.feesUsd ?? 0)!,
      pnlUsd: round(pnl),
      pnlPct: round(pnlPct),
    });
  }
  holdings.sort((a, b) =>
    a.kind === "cash" ? -1 : b.kind === "cash" ? 1 : (b.valueUsd ?? 0) - (a.valueUsd ?? 0),
  );

  // Activity: our swaps first (they carry status), then chain deposits, then indexed meme trades. De-duped by signature.
  const seen = new Set<string>();
  const activity: Act[] = [];
  let pendingSwaps = 0;
  for (const r of swapRows) {
    const a = swapAct(r, meta);
    if (a.status === "pending") pendingSwaps++;
    if (r.signature) seen.add(r.signature);
    activity.push(a);
  }
  for (const d of transfers) {
    if (seen.has(d.sig)) continue;
    seen.add(d.sig);
    activity.push(depositAct(d));
  }
  for (const r of tradeRows) {
    if (seen.has(r.signature)) continue;
    activity.push(tradeAct(r));
  }
  activity.sort((a, b) => b.ts - a.ts);

  return {
    address,
    totalUsd: round(cashUsd + solUsd + stocksUsd + memesUsd)!,
    cashUsd: round(cashUsd)!,
    solUsd: round(solUsd)!,
    stocksUsd: round(stocksUsd)!,
    memesUsd: round(memesUsd)!,
    costUsd: round(costUsd)!,
    feesUsd: round(feesUsd)!,
    pnlUsd: round(pnlUsd)!,
    realizedUsd: round(realizedUsd)!,
    pendingSwaps,
    holdings,
    activity: activity.slice(0, activityLimit),
    asOf: Math.floor(Date.now() / 1000),
  };
}
