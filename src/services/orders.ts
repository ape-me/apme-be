import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import {
  USDC_MINT,
  referralAta,
  gasKeypair,
  sha256hex,
  connection,
  ata,
  gasPays,
  buildV0,
  lookupTables,
  createAtaIdempotent,
  transferChecked,
  ATA_RENT_LAMPORTS,
  ATA_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from "../lib/solana";
import { ordersRepo, type OrderRow } from "../repos/orders";
import { swapsRepo } from "../repos/swaps";
import { solPrice as solUsd } from "../lib/rpc";
import { configNum } from "./config";
import { accountRepo } from "../repos/account";
import { jupBase, jupHeaders, signedByUser } from "./swap";
import type { UserRow, WalletRow } from "../repos/account";
import { PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";

// Limit orders live in Jupiter's Trigger program: they hold the escrow and their keepers fill it. We build,
// take the signature, and keep our own row so the order has a user, a symbol and a cost basis.

const FEE_BPS = 150;
const MAX_OPEN = 20;
// Fallbacks only: the live values are the app_config keys `orders.min_usd` and `orders.min_gap_bps`.
const MIN_ORDER_USD = 5;
const MIN_GAP_BPS = 0;
// Jupiter's order account (372 bytes) plus its escrow. Measured on chain; the refund goes to the maker on
// fill, never to whoever paid it, so it is a real cost to us unless the order carries it.
const ORDER_RENT_LAMPORTS = 4_030_000;
// Jupiter refuses any mint with a transfer fee, which today is every PreStocks name.
const EXCLUDED_ISSUERS = ["prestocks"];

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

// The escrow has to be covered before we build anything, so a short wallet is told what it is missing.
async function requireUsdc(env: Env, wallet: string, needed: number) {
  const usdc = new PublicKey(USDC_MINT);
  const info = await connection(env).getAccountInfo(ata(new PublicKey(wallet), usdc));
  const held = info ? Number(new DataView(info.data.buffer, info.data.byteOffset).getBigUint64(64, true)) : 0;
  if (held < needed)
    throw new HttpError(422, "insufficient_usdc", {
      neededUsd: needed / 1e6,
      heldUsd: held / 1e6,
      shortUsd: Math.ceil((needed - held) / 10_000) / 100,
    });
}

// A first buy of a stonk has to open the maker's token account. Jupiter bills that to the maker, who holds no
// SOL, so the gas wallet pays it on chain and the escrow carries it back to us.
async function ataRent(env: Env, wallet: string, mint: string) {
  const [owner, m] = [new PublicKey(wallet), new PublicKey(mint)];
  const infos = await connection(env).getMultipleAccountsInfo([
    ata(owner, m),
    ata(owner, m, TOKEN_2022_PROGRAM),
  ]);
  return infos.some((i) => i) ? 0 : ATA_RENT_LAMPORTS;
}

const ownWallet = (wallets: WalletRow[], address: string) => {
  if (!wallets.some((w) => w.address === address && w.chain === "solana"))
    throw new HttpError(403, "wallet is not one of yours");
};

// Every rule the order sheet needs, so the phone never has to hardcode one or learn it from a refusal.
export async function orderConfig(sql: Sql) {
  const [minUsd, minGapBps] = await Promise.all([
    configNum(sql, "orders.min_usd", MIN_ORDER_USD),
    configNum(sql, "orders.min_gap_bps", MIN_GAP_BPS),
  ]);
  return {
    minUsd,
    minGapBps,
    maxOpen: MAX_OPEN,
    buyFeeBps: 0,
    sellFeeBps: FEE_BPS,
    accountCostUsd: 0,
    excludedIssuers: EXCLUDED_ISSUERS,
  };
}

// Jupiter bills the maker for gas and for the token account it opens, and our makers hold no SOL. We rebuild
// its transaction with the gas wallet paying both, and add one USDC transfer that settles what we fronted.
async function withCharge(
  env: Env & { FEE_WALLET: string },
  built: string,
  gas: PublicKey,
  maker: PublicKey,
  chargeRaw: bigint,
) {
  const conn = connection(env);
  const jup = VersionedTransaction.deserialize(Buffer.from(built, "base64"));
  const alts = await lookupTables(
    conn,
    jup.message.addressTableLookups.map((l) => l.accountKey.toBase58()),
  );
  const ixs = TransactionMessage.decompile(jup.message, { addressLookupTableAccounts: alts }).instructions;
  for (const ix of ixs)
    if (ix.programId.equals(ATA_PROGRAM)) ix.keys[0] = { pubkey: gas, isSigner: true, isWritable: true };
  const usdc = new PublicKey(USDC_MINT);
  const fee = new PublicKey(env.FEE_WALLET);
  const charge = chargeRaw
    ? [
        createAtaIdempotent(gas, fee, usdc, TOKEN_PROGRAM),
        transferChecked(ata(maker, usdc), usdc, ata(fee, usdc), maker, chargeRaw, 6, TOKEN_PROGRAM),
      ]
    : [];
  const { tx } = await buildV0(conn, gas, [...charge, ...ixs], alts);
  return tx;
}

export async function quoteOrder(env: Env, sql: Sql, user: UserRow, wallets: WalletRow[], q: OrderInput) {
  ownWallet(wallets, q.wallet);
  if (!env.JUP_REFERRAL_ACCOUNT || !env.FEE_WALLET) throw new HttpError(503, "orders are not configured");
  const [stock] = await swapsRepo.stockMeta(sql, q.mint);
  if (!stock) throw notFound("stock");
  // Jupiter refuses any mint with a transfer fee, which is every PreStocks name.
  if (EXCLUDED_ISSUERS.includes(stock.issuer))
    throw new HttpError(400, "limit orders are not available for pre-IPO tokens", {
      excludedIssuers: EXCLUDED_ISSUERS,
    });
  if ((await ordersRepo.openFor(sql, user.id)).length >= MAX_OPEN)
    throw new HttpError(429, "too many open orders");

  const dec = Number(stock.decimals);
  const mult = Number(stock.multiplier ?? 1);
  const making = Number(q.amount);
  if (!Number.isFinite(making) || making <= 0) throw badRequest("amount must be a positive integer");
  // priceUsd is per displayed unit, so a raw amount converts through both the decimals and the multiplier.
  const displayed = (raw: number) => (raw / 10 ** dec) * mult;
  const spot = Number(stock.price_usd ?? 0);
  const orderUsd = q.side === "buy" ? making / 1e6 : displayed(making) * spot;
  const [minUsd, minGapBps] = await Promise.all([
    configNum(sql, "orders.min_usd", MIN_ORDER_USD),
    configNum(sql, "orders.min_gap_bps", MIN_GAP_BPS),
  ]);
  if (orderUsd < minUsd) throw new HttpError(400, `orders start at $${minUsd}`, { minUsd });
  // A trigger already in the money is a market order in disguise: it fills on the next keeper pass and
  // skips the swap fee. A limit order waits for a price that has not happened yet.
  const buy = q.side === "buy";
  const limitUsd = spot * (buy ? 1 - minGapBps / 10_000 : 1 + minGapBps / 10_000);
  if (spot > 0 && (buy ? q.triggerUsd >= limitUsd : q.triggerUsd <= limitUsd))
    throw new HttpError(
      400,
      buy
        ? "a limit buy has to sit below the current price — use the buy ticket to fill now"
        : "a limit sell has to sit above the current price — use the sell ticket to fill now",
      { spotUsd: spot, limitUsd: Math.round(limitUsd * 1e4) / 1e4, minGapBps },
    );
  const taking =
    q.side === "buy"
      ? Math.round((orderUsd / q.triggerUsd / mult) * 10 ** dec)
      : Math.round(displayed(making) * q.triggerUsd * 1e6);
  if (taking <= 0) throw badRequest("trigger price is too far from the amount");

  // Jupiter takes its cut out of the mint the order pays OUT, and the referral program cannot hold a
  // Token-2022 stonk: only a sell, which pays out USDC, can carry a fee. A buy is free and we eat its rent.
  const [sol, ataLamports] = await Promise.all([
    solUsd(),
    q.side === "buy" ? ataRent(env, q.wallet, q.mint) : 0,
  ]);
  const feeBps = q.side === "sell" ? FEE_BPS : 0;
  const feeUsd = feeBps ? Math.round(orderUsd * feeBps) / 10_000 : 0;

  // We front every lamport this order costs, and Jupiter refunds the deposit to the maker, not to us. So the
  // maker pays it here in USDC and gets it back in SOL when the order closes: square on both sides.
  const sameMint = ataLamports ? await ordersRepo.openForMint(sql, user.id, q.mint) : [];
  const rentLamports = ORDER_RENT_LAMPORTS + (sameMint.length ? 0 : ataLamports);
  const chargeRaw = buy && sol ? BigInt(Math.ceil((rentLamports / 1e9) * sol * 1e6)) : 0n;
  if (buy) await requireUsdc(env, q.wallet, making + Number(chargeRaw));

  const gas = gasKeypair(env).publicKey;
  const built = await trigger<{ order: string; requestId: string; transaction: string }>(env, "createOrder", {
    inputMint: q.side === "buy" ? USDC_MINT : q.mint,
    outputMint: q.side === "buy" ? q.mint : USDC_MINT,
    maker: q.wallet,
    payer: gas.toBase58(),
    ...(feeBps ? { feeAccount: referralAta(env.JUP_REFERRAL_ACCOUNT, USDC_MINT) } : {}),
    params: {
      makingAmount: String(making),
      takingAmount: String(taking),
      ...(feeBps ? { feeBps: String(feeBps) } : {}),
    },
    computeUnitPrice: "auto",
  });

  const tx = await withCharge(
    env as Env & { FEE_WALLET: string },
    built.transaction,
    gas,
    new PublicKey(q.wallet),
    chargeRaw,
  );
  const rentUsd = Number(chargeRaw) / 1e6;
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
    making_usd: orderUsd,
    trigger_usd: q.triggerUsd,
    rent_usd: rentUsd,
    request_id: built.requestId,
    msg_hash: await sha256hex(tx.message.serialize()),
    t,
  });
  return {
    id: built.order,
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    side: q.side,
    symbol: stock.symbol,
    escrowRaw: String(making),
    takingRaw: String(taking),
    orderUsd,
    escrowUsd: q.side === "buy" ? making / 1e6 : null,
    triggerUsd: q.triggerUsd,
    costUsd: rentUsd,
    totalUsd: making / 1e6 + rentUsd,
    fee: {
      bps: feeBps,
      usd: feeUsd,
      when: feeBps
        ? "taken from the proceeds when it fills — cancel and nothing is charged"
        : "buy orders are free: we cover the on-chain cost of the order",
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
  const t = Math.floor(Date.now() / 1000);
  try {
    const signature = await send(env, signedTransaction, row);
    await ordersRepo.markOpen(sql, row.id, signature, t);
    return { id: row.id, status: "open" as const, signature };
  } catch (e) {
    if (e instanceof HttpError) throw e;
    const msg = (e as Error).message.slice(0, 300);
    await ordersRepo.markFailed(sql, row.id, msg, t);
    throw new HttpError(422, msg);
  }
}

// We rewrote the fee payer, so Jupiter's execute would no longer recognise its own transaction: we broadcast.
async function send(env: Env, signedTransaction: string, row: OrderRow) {
  const tx = await signedByUser(signedTransaction, row.wallet, row.msg_hash);
  tx.sign([gasKeypair(env)]);
  try {
    return await connection(env).sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
  } catch (e) {
    const msg = (e as Error).message;
    if (/blockhash not found/i.test(msg)) throw new HttpError(410, "quote_expired");
    throw e;
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
  const tx = gasPays(
    VersionedTransaction.deserialize(Buffer.from(built.transaction, "base64")),
    gasKeypair(env).publicKey,
  );
  await ordersRepo.setPending(
    sql,
    row.id,
    built.requestId,
    await sha256hex(tx.message.serialize()),
    Math.floor(Date.now() / 1000),
  );
  return { id: row.id, transaction: Buffer.from(tx.serialize()).toString("base64") };
}

export async function submitCancel(env: Env, sql: Sql, user: UserRow, id: string, signedTransaction: string) {
  const [row] = await ordersRepo.byId(sql, id, user.id);
  if (!row) throw notFound("order");
  if (row.status !== "open") throw new HttpError(409, `order is ${row.status}`);
  await send(env, signedTransaction, row);
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
