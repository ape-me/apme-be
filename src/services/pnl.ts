import type { Sql } from "../lib/db";
import { walletRepo, type FillRow } from "../repos/wallet";
import { swapsRepo } from "../repos/swaps";
import { HttpError, notFound } from "../lib/errors";
import type { UserRow } from "../repos/account";
import { basketsRepo } from "../repos/baskets";

type Basis = { paid: number; opened: number };
export const BENCHMARK = "SPY";

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${n >= 0 ? "+" : ""}${n}%`;
const span = (s: number) =>
  s < 3600
    ? `${Math.max(1, Math.round(s / 60))}m`
    : s < 86400
      ? `${Math.round(s / 3600)}h`
      : `${Math.round(s / 86400)}d`;

// Average cost per (basket or single, mint): each sell costs its share of what the open position paid, and a position
// that sells down to dust starts over. A basket's shares and the same stock bought on its own are separate positions.
// Null when a sell is bigger than anything we saw bought (tokens that came from outside the app).
export function costBasis(fills: FillRow[]) {
  const open = new Map<string, { qty: bigint; cost: number; opened: number }>();
  const out = new Map<string, Basis | null>();
  for (const f of fills) {
    const key = `${f.basket_id ?? ""}:${f.side === "buy" ? f.output_mint : f.input_mint}`;
    const p = open.get(key);
    if (f.side === "buy") {
      const n = p ?? open.set(key, { qty: 0n, cost: 0, opened: Number(f.created_at) }).get(key)!;
      n.qty += BigInt(f.out_raw ?? 0);
      n.cost += Number(f.in_usd ?? 0);
      continue;
    }
    const sold = BigInt(f.in_raw);
    if (!p || sold > p.qty + p.qty / 1000n) {
      out.set(f.id, null);
      continue;
    }
    const paid = sold >= p.qty ? p.cost : (p.cost * Number(sold)) / Number(p.qty);
    out.set(f.id, { paid, opened: p.opened });
    p.cost -= paid;
    p.qty -= sold;
    if (p.qty <= sold / 1000n) open.delete(key);
  }
  return out;
}

export const pnlPct = (paid: number, received: number) => (paid ? round2((received / paid - 1) * 100) : null);

// The card's common half: totals, the hold, the S&P 500 over the same hold, and a share line.
export async function pnlCard(
  sql: Sql,
  user: UserRow,
  label: string,
  a: { paid: number; received: number; openedAt: number; closedAt: number },
) {
  const [spOpen, spClose] = await Promise.all([
    basketsRepo.priceAt(sql, BENCHMARK, a.openedAt),
    basketsRepo.priceAt(sql, BENCHMARK, a.closedAt),
  ]);
  const paidUsd = round2(a.paid);
  const receivedUsd = round2(a.received);
  const p = pnlPct(a.paid, a.received);
  const sp = spOpen && spClose ? round2((spClose / spOpen - 1) * 100) : null;
  const heldSeconds = a.closedAt - a.openedAt;
  return {
    paidUsd,
    receivedUsd,
    pnlUsd: round2(receivedUsd - paidUsd),
    pnlPct: p,
    openedAt: a.openedAt,
    closedAt: a.closedAt,
    heldSeconds,
    benchmark: { name: "S&P 500", ticker: BENCHMARK, pnlPct: sp },
    share: {
      link: `https://stonks247.fun/i/${user.referral_code}`,
      text:
        p == null
          ? `closed ${label} on stonks247`
          : `${pct(p)} on ${label} in ${span(heldSeconds)}${sp == null || heldSeconds < 3600 ? "" : `, s&p did ${pct(sp)}`}. stonks247`,
    },
  };
}

// The single-stock card: one sell swap against the average cost of the units it sold.
export async function swapPnl(sql: Sql, user: UserRow, requestId: string) {
  const [row] = await swapsRepo.byId(sql, requestId, user.id);
  if (!row) throw notFound("swap");
  if (row.side !== "sell") throw new HttpError(409, "not_a_sell");
  if (row.status !== "confirmed") throw new HttpError(409, "sell_not_confirmed");
  const [fills, [meta]] = await Promise.all([
    walletRepo.fills(sql, row.wallet),
    walletRepo.known(sql, [row.input_mint]),
  ]);
  const b = costBasis(fills).get(row.id);
  if (!b) throw new HttpError(409, "cost_unknown"); // sold more than we saw bought: tokens came from outside the app
  const symbol = meta?.symbol ?? row.symbol ?? "a stock";
  return {
    requestId,
    mint: row.input_mint,
    symbol,
    name: meta?.name ?? null,
    logo: meta?.image ?? null,
    complete: true,
    ...(await pnlCard(sql, user, symbol, {
      paid: b.paid,
      received: Number(row.out_raw ?? 0) / 1e6,
      openedAt: b.opened,
      closedAt: Number(row.created_at),
    })),
  };
}
