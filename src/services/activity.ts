import type { Sql } from "../lib/db";
import type { z } from "zod";
import { walletRepo } from "../repos/wallet";
import type { ActivityRow, SwapActivityRow, KnownRow } from "../repos/wallet";
import type { Activity } from "../contract";
import { USDC_MINT } from "../lib/rpc";

export type Act = z.infer<typeof Activity>;
export type Meta = Map<string, KnownRow>;

export const USDC_LOGO =
  "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png";

const round = (v: number | null | undefined, d = 2) =>
  v == null || !Number.isFinite(v) ? null : Math.round(v * 10 ** d) / 10 ** d;

// Three sources, one shape: our swaps carry a status, chain transfers and indexed floor trades are settled.
export function swapAct(r: SwapActivityRow, meta: Meta): Act {
  const tokenMint = r.side === "buy" ? r.output_mint : r.input_mint;
  const tm = meta.get(tokenMint);
  const decimals = tm?.decimals ?? 6;
  const tokenRaw = r.side === "buy" ? r.out_raw : r.in_raw;
  return {
    sig: r.signature,
    ts: Number(r.confirmed_at ?? r.created_at),
    type: r.side,
    status: r.status === "confirmed" ? "confirmed" : r.status === "failed" ? "failed" : "pending",
    source: "apeme",
    side: r.side,
    mint: tokenMint,
    symbol: r.symbol ?? tm?.symbol ?? null,
    image: tm?.image ?? null,
    stockSymbol: tm?.kind === "meme" ? tm.quote_symbol : null,
    amount: tokenRaw
      ? (Number(tokenRaw) / 10 ** decimals) * (tm?.kind === "stock" ? Number(tm.multiplier ?? 1) : 1)
      : 0,
    quote: r.side === "buy" ? Number(r.in_raw) / 1e6 : r.out_raw == null ? null : Number(r.out_raw) / 1e6,
    usd: round(r.side === "buy" ? r.in_usd : r.out_usd),
    feeUsd: round(r.fee_usd),
    from: null,
    error: r.error,
  };
}

export function depositAct(d: {
  sig: string;
  ts: number;
  amount: number;
  from: string | null;
  direction: "in" | "out";
}): Act {
  return {
    sig: d.sig,
    ts: d.ts,
    type: d.direction === "in" ? "deposit" : "withdraw",
    status: "confirmed",
    source: "chain",
    side: null,
    mint: USDC_MINT,
    symbol: "USDC",
    image: USDC_LOGO,
    stockSymbol: null,
    amount: d.amount,
    quote: null,
    usd: round(d.amount),
    feeUsd: null,
    from: d.from,
    error: null,
  };
}

export function tradeAct(r: ActivityRow): Act {
  const quote = Number(r.quote_raw) / 10 ** r.quote_decimals;
  return {
    sig: r.signature,
    ts: Number(r.block_time),
    type: r.side,
    status: "confirmed",
    source: "chain",
    side: r.side,
    mint: r.token_mint,
    symbol: r.symbol,
    image: r.image,
    stockSymbol: r.stock_symbol,
    amount: Number(r.base_raw) / 10 ** r.decimals,
    quote,
    usd: round(quote * (r.quote_usd ?? r.stock_price_usd ?? NaN)),
    feeUsd: null,
    from: null,
    error: null,
  };
}

export type ActivityQuery = {
  types: string[];
  mint: string | null;
  from: number | null;
  to: number | null;
  limit: number;
  cursor: string | null;
};

// The cursor is the last row's timestamp and signature: a second at the page boundary can hold several rows.
const decode = (c: string | null) => {
  if (!c) return null;
  const [ts, sig] = Buffer.from(c, "base64url").toString().split("|");
  return ts ? { ts: Number(ts), sig: sig ?? "" } : null;
};
const encode = (a: Act) => Buffer.from(`${a.ts}|${a.sig ?? ""}`).toString("base64url");

// Every source is asked for one page ending at the cursor, then merged and cut. Asking each for `limit` rows
// is enough: whichever source the page ends in, the rows beyond the cut are simply fetched again next time.
export async function activityPage(sql: Sql, address: string, q: ActivityQuery) {
  const cur = decode(q.cursor);
  const sides = q.types.filter((t) => t === "buy" || t === "sell");
  const directions = q.types.flatMap((t) => (t === "deposit" ? ["in"] : t === "withdraw" ? ["out"] : []));
  const wantTrades = !q.types.length || sides.length > 0;
  const wantDeposits = (!q.types.length || directions.length > 0) && !q.mint;
  const page = {
    wallet: address,
    sides,
    mint: q.mint,
    from: q.from,
    to: q.to,
    before: cur?.ts ?? null,
    limit: q.limit + 1,
  };
  const [swaps, trades, deposits] = await Promise.all([
    wantTrades ? walletRepo.swapPage(sql, page) : [],
    wantTrades ? walletRepo.tradePage(sql, page) : [],
    wantDeposits
      ? walletRepo.depositPage(sql, { ...page, directions: directions.length ? directions : ["in", "out"] })
      : [],
  ]);
  const mints = [...new Set(swaps.map((r) => (r.side === "buy" ? r.output_mint : r.input_mint)))].filter(
    (m) => m !== USDC_MINT,
  );
  const known = mints.length ? await walletRepo.known(sql, mints) : [];
  const meta: Meta = new Map(known.map((k) => [k.mint, k]));

  const seen = new Set<string>();
  const all: Act[] = [];
  for (const r of swaps) {
    if (r.signature) seen.add(r.signature);
    all.push(swapAct(r, meta));
  }
  for (const d of deposits)
    if (!seen.has(d.signature)) {
      seen.add(d.signature);
      all.push(
        depositAct({
          sig: d.signature,
          ts: Number(d.ts),
          amount: Number(d.amount),
          from: d.from_addr,
          direction: d.direction,
        }),
      );
    }
  for (const r of trades) if (!seen.has(r.signature)) all.push(tradeAct(r));

  all.sort((a, b) => b.ts - a.ts || (b.sig ?? "").localeCompare(a.sig ?? ""));
  const after = cur ? all.filter((a) => a.ts < cur.ts || (a.ts === cur.ts && (a.sig ?? "") < cur.sig)) : all;
  const rows = after.slice(0, q.limit);
  return {
    activity: rows,
    next: after.length > q.limit && rows.length ? encode(rows[rows.length - 1]!) : null,
  };
}
