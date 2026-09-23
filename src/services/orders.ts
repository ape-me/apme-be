import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { USDC_MINT, gasKeypair, sha256hex } from "../lib/solana";
import { ordersRepo, type OrderRow } from "../repos/orders";
import { swapsRepo } from "../repos/swaps";
import { solPrice as solUsd } from "../lib/rpc";
import { accountRepo } from "../repos/account";
import { jupBase, jupHeaders, signedByUser } from "./swap";
import type { UserRow, WalletRow } from "../repos/account";
import { VersionedTransaction } from "@solana/web3.js";

// Limit orders live in Jupiter's Trigger program: they hold the escrow and their keepers fill it. We build,
// take the signature, and keep our own row so the order has a user, a symbol and a cost basis.

const FEE_BPS = 150;
const MAX_OPEN = 20;
const MIN_ORDER_USD = 10;
// Jupiter's order account (372 bytes) plus its escrow. Measured on chain; the refund goes to the maker on
// fill, never to whoever paid it, so it is a real cost to us unless the order carries it.
const ORDER_RENT_LAMPORTS = 4_030_000;

export type OrderInput = {
  wallet: string;
  mint: string;
  side: "buy" | "sell";
  amount: string;
  triggerUsd: number;
};

type JupOrder = {
  orderKey: string;
  inputMint: string;
  outputMint: string;
  makingAmount: string;
  takingAmount: string;
  remainingMakingAmount?: string;
  remainingTakingAmount?: string;
  trades?: unknown[];
};

const trigger = async <T>(env: Env, path: string, body?: unknown): Promise<T> => {
  const r = await fetch(`${jupBase(env)}/trigger/v1/${path}`, {
    method: body ? "POST" : "GET",
    headers: jupHeaders(env),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const j = (await r.json()) as T & { error?: string };
  if (!r.ok || j.error) throw new HttpError(422, j.error ?? `jupiter ${path} failed`);
  return j;
};

const shape = (o: OrderRow) => ({
  id: o.id,
  mint: o.mint,
  symbol: o.symbol,
  side: o.side,
  makingRaw: o.making_raw,
  takingRaw: o.taking_raw,
  makingUsd: o.making_usd,
  triggerUsd: o.trigger_usd,
  status: o.status,
  signature: o.signature,
  createdAt: Number(o.created_at),
  filledAt: o.filled_at == null ? null : Number(o.filled_at),
  fillUsd: o.fill_usd,
  feeUsd: o.fee_usd,
  rentUsd: o.rent_usd,
  error: o.error,
});

const ownWallet = (wallets: WalletRow[], address: string) => {
  if (!wallets.some((w) => w.address === address && w.chain === "solana"))
    throw new HttpError(403, "wallet is not one of yours");
};

export async function quoteOrder(env: Env, sql: Sql, user: UserRow, wallets: WalletRow[], q: OrderInput) {
  ownWallet(wallets, q.wallet);
  if (!env.JUP_REFERRAL_ACCOUNT) throw new HttpError(503, "orders are not configured");
  const [stock] = await swapsRepo.stockMeta(sql, q.mint);
  if (!stock) throw notFound("stock");
  // Jupiter refuses any mint with a transfer fee, which is every PreStocks name.
  if (stock.issuer === "prestocks") throw badRequest("limit orders are not available for pre-IPO tokens");
  if ((await ordersRepo.openFor(sql, user.id)).length >= MAX_OPEN)
    throw new HttpError(429, "too many open orders");

  const dec = Number(stock.decimals);
  const mult = Number(stock.multiplier ?? 1);
  const making = Number(q.amount);
  if (!Number.isFinite(making) || making <= 0) throw badRequest("amount must be a positive integer");
  // priceUsd is per displayed unit, so a raw amount converts through both the decimals and the multiplier.
  const displayed = (raw: number) => (raw / 10 ** dec) * mult;
  const makingUsd = q.side === "buy" ? making / 1e6 : displayed(making) * Number(stock.price_usd ?? 0);
  if (makingUsd < MIN_ORDER_USD) throw badRequest(`orders start at $${MIN_ORDER_USD}`);
  const taking =
    q.side === "buy"
      ? Math.round((making / 1e6 / q.triggerUsd / mult) * 10 ** dec)
      : Math.round(displayed(making) * q.triggerUsd * 1e6);
  if (taking <= 0) throw badRequest("trigger price is too far from the amount");

  // The rent rides on the order's own fee, so Jupiter collects it for us when the order fills.
  const sol = await solUsd();
  const rentUsd = sol ? Math.ceil((ORDER_RENT_LAMPORTS / 1e9) * sol * 100) / 100 : 0;
  const rentBps = Math.ceil((rentUsd / makingUsd) * 10_000);
  const feeBps = FEE_BPS + rentBps;

  const built = await trigger<{ order: string; requestId: string; transaction: string }>(env, "createOrder", {
    inputMint: q.side === "buy" ? USDC_MINT : q.mint,
    outputMint: q.side === "buy" ? q.mint : USDC_MINT,
    maker: q.wallet,
    payer: gasKeypair(env).publicKey.toBase58(),
    feeAccount: env.JUP_REFERRAL_ACCOUNT,
    params: {
      makingAmount: String(making),
      takingAmount: String(taking),
      feeBps: String(FEE_BPS),
    },
    computeUnitPrice: "auto",
  });

  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  const t = Math.floor(Date.now() / 1000);
  await ordersRepo.insert(sql, {
    id: built.order,
    user_id: user.id,
    wallet: q.wallet,
    mint: q.mint,
    symbol: stock.symbol,
    side: q.side,
    input_mint: q.side === "buy" ? USDC_MINT : q.mint,
    output_mint: q.side === "buy" ? q.mint : USDC_MINT,
    making_raw: String(making),
    taking_raw: String(taking),
    making_usd: makingUsd,
    trigger_usd: q.triggerUsd,
    rent_usd: rentUsd,
    request_id: built.requestId,
    msg_hash: await sha256hex(tx.message.serialize()),
    t,
  });
  return {
    id: built.order,
    transaction: built.transaction,
    side: q.side,
    symbol: stock.symbol,
    makingRaw: String(making),
    takingRaw: String(taking),
    makingUsd,
    triggerUsd: q.triggerUsd,
    fee: {
      bps: FEE_BPS,
      usd: Math.round(makingUsd * FEE_BPS) / 10_000,
      rentUsd,
      totalBps: feeBps,
      totalUsd: Math.round(makingUsd * feeBps) / 10_000,
      note: "1.5% plus the on-chain account cost, taken by Jupiter when the order fills",
    },
  };
}

// Ops: build a real order for a wallet we already know, without a phone. Nothing is signed, so nothing happens
// on chain; it proves the amounts, the Jupiter call and our row in one go.
export async function simulateOrder(env: Env, sql: Sql, q: OrderInput) {
  const [owner] = await accountRepo.byWallet(sql, q.wallet);
  if (!owner) throw notFound("wallet");
  return quoteOrder(
    env,
    sql,
    { id: owner.user_id } as UserRow,
    [{ address: q.wallet, chain: "solana" } as WalletRow],
    q,
  );
}

export async function submitOrder(env: Env, sql: Sql, user: UserRow, id: string, signedTransaction: string) {
  const [row] = await ordersRepo.byId(sql, id, user.id);
  if (!row) throw notFound("order");
  if (row.status !== "quoted") throw new HttpError(409, `order already ${row.status}`);
  const tx = await signedByUser(signedTransaction, row.wallet, row.msg_hash);
  tx.sign([gasKeypair(env)]);
  const t = Math.floor(Date.now() / 1000);
  try {
    const res = await trigger<{ signature: string }>(env, "execute", {
      requestId: row.request_id,
      signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
    });
    await ordersRepo.markOpen(sql, row.id, res.signature, t);
    return { id: row.id, status: "open" as const, signature: res.signature };
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await ordersRepo.markFailed(sql, row.id, msg, t);
    throw new HttpError(422, msg);
  }
}

export async function cancelOrder(env: Env, sql: Sql, user: UserRow, id: string) {
  const [row] = await ordersRepo.byId(sql, id, user.id);
  if (!row) throw notFound("order");
  if (row.status !== "open") throw new HttpError(409, `order is ${row.status}`);
  const built = await trigger<{ requestId: string; transaction: string }>(env, "cancelOrder", {
    maker: row.wallet,
    order: row.id,
    computeUnitPrice: "auto",
  });
  const tx = VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64"));
  await ordersRepo.setPending(
    sql,
    row.id,
    built.requestId,
    await sha256hex(tx.message.serialize()),
    Math.floor(Date.now() / 1000),
  );
  return { id: row.id, transaction: built.transaction };
}

export async function submitCancel(env: Env, sql: Sql, user: UserRow, id: string, signedTransaction: string) {
  const [row] = await ordersRepo.byId(sql, id, user.id);
  if (!row) throw notFound("order");
  if (row.status !== "open") throw new HttpError(409, `order is ${row.status}`);
  const tx = await signedByUser(signedTransaction, row.wallet, row.msg_hash);
  tx.sign([gasKeypair(env)]);
  await trigger(env, "execute", {
    requestId: row.request_id,
    signedTransaction: Buffer.from(tx.serialize()).toString("base64"),
  });
  const t = Math.floor(Date.now() / 1000);
  await ordersRepo.settle(sql, row.id, "cancelled", row.fill_usd, row.fee_usd, t);
  return { id: row.id, status: "cancelled" as const };
}

// Jupiter is the truth. Anything of ours still marked open is reconciled against their active and history lists.
export async function listOrders(env: Env, sql: Sql, user: UserRow, wallets: WalletRow[], limit: number) {
  const open = await ordersRepo.openFor(sql, user.id);
  if (open.length) {
    const addresses = [...new Set(open.map((o) => o.wallet))].filter((a) =>
      wallets.some((w) => w.address === a),
    );
    const pages = await Promise.all(
      addresses.flatMap((a) =>
        (["active", "history"] as const).map(async (status) => {
          try {
            const r = await trigger<{ orders: JupOrder[] }>(
              env,
              `getTriggerOrders?user=${a}&orderStatus=${status}`,
            );
            return (r.orders ?? []).map((o) => [status, o] as const);
          } catch {
            return [];
          }
        }),
      ),
    );
    const seen = new Map(pages.flat().map(([status, o]) => [o.orderKey, { status, o }]));
    const t = Math.floor(Date.now() / 1000);
    await Promise.all(
      open.map(async (row) => {
        const hit = seen.get(row.id);
        if (!hit || hit.status === "active") return;
        const filled = (hit.o.trades?.length ?? 0) > 0;
        const usdLeg = row.side === "buy" ? hit.o.makingAmount : hit.o.takingAmount;
        const remaining = row.side === "buy" ? hit.o.remainingMakingAmount : hit.o.remainingTakingAmount;
        const fillUsd = filled ? Number(usdLeg) - Number(remaining ?? 0) : null;
        await ordersRepo.settle(
          sql,
          row.id,
          filled ? "filled" : "cancelled",
          fillUsd,
          fillUsd == null ? null : (fillUsd * FEE_BPS) / 10_000,
          t,
        );
      }),
    );
  }
  return { orders: (await ordersRepo.forUser(sql, user.id, limit)).map(shape) };
}
