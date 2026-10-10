import type { Sql } from "../lib/db";
import { walletRepo, type FillRow } from "../repos/wallet";
import { swapsRepo } from "../repos/swaps";
import { HttpError, notFound } from "../lib/errors";
import type { UserRow } from "../repos/account";
import { basketsRepo } from "../repos/baskets";
import { stocksRepo } from "../repos/stocks";

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

type Point = { t: number; value: number };
// A csv price line; gaps carry the previous price forward.
const series = (points: string) => {
  let last: number | null = null;
  return points.split(",").map((x) => (last = x === "" ? last : Number(x)));
};

// The position over the hold, weighted by what each leg paid, and the S&P 500 on the same marks, both from 100 at
// the first mark every leg has a price. ~60 marks, whole minutes apart (whole hours past 60h). The last point is the
// real exit, so the line ends where the card's P/L does. Null under 2 minutes or with no snapshots in the hold.
async function holdLine(
  sql: Sql,
  legs: { mint: string; paid: number }[],
  a: { paid: number; received: number; openedAt: number; closedAt: number },
) {
  const held = a.closedAt - a.openedAt;
  if (held < 120) return null;
  const unit = held < 60 * 3600 ? 60 : 3600;
  const step = Math.max(1, Math.round(held / 60 / unit)) * unit;
  const rows = await stocksRepo.line(
    sql,
    [...new Set(legs.map((l) => l.mint))],
    BENCHMARK,
    a.openedAt,
    a.closedAt,
    step,
  );
  const by = new Map(rows.map((r) => [r.mint, series(r.points)]));
  const bench = rows.find((r) => r.bench);
  const n = rows[0] ? rows[0].points.split(",").length : 0;
  const start = [...Array(n).keys()].find((i) => legs.every((l) => by.get(l.mint)?.[i]));
  if (start == null || start === n - 1) return null;
  const b = bench && series(bench.points);
  const marks = [...Array(n).keys()].slice(start);
  const t = (i: number) => Math.min(a.openedAt + i * step, a.closedAt);
  const points: Point[] = marks.map((i) => ({
    t: t(i),
    value: round2(
      legs.reduce((s, l) => s + (l.paid / a.paid) * (by.get(l.mint)![i]! / by.get(l.mint)![start]!), 0) * 100,
    ),
  }));
  points[points.length - 1]!.value = round2((a.received / a.paid) * 100);
  return {
    points,
    benchmark: b?.[start] ? marks.map((i) => ({ t: t(i), value: round2((b[i]! / b[start]!) * 100) })) : null,
  };
}

// The card's common half: totals, the hold, the S&P 500 over the same hold, and a share line.
export async function pnlCard(
  sql: Sql,
  user: UserRow,
  label: string,
  legs: { mint: string; paid: number }[],
  a: { paid: number; received: number; openedAt: number; closedAt: number },
) {
  const [spOpen, spClose, line] = await Promise.all([
    basketsRepo.priceAt(sql, BENCHMARK, a.openedAt),
    basketsRepo.priceAt(sql, BENCHMARK, a.closedAt),
    holdLine(sql, legs, a),
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
    points: line?.points ?? null,
    benchmark: { name: "S&P 500", ticker: BENCHMARK, pnlPct: sp, points: line?.benchmark ?? null },
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
    ...(await pnlCard(sql, user, symbol, [{ mint: row.input_mint, paid: b.paid }], {
      paid: b.paid,
      received: Number(row.out_raw ?? 0) / 1e6,
      openedAt: b.opened,
      closedAt: Number(row.created_at),
    })),
  };
}
