import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import {
  USDC_MINT,
  SOL_MINT,
  connection,
  gasKeypair,
  ata,
  mintInfo,
  ultraReferralAccount,
  initReferralAccount,
  createAtaIdempotent,
  TOKEN_PROGRAM,
  buildV0,
  sha256hex,
  u8,
} from "../lib/solana";
import { swapsRepo } from "../repos/swaps";
import { tradable } from "./shape";
import type { UserRow, WalletRow, SettingsRow } from "../repos/account";

// USDC-only trading on Jupiter's Swap API v2 `/order`: one call quotes and assembles the transaction, Jupiter picks
// the venue (pools via Metis, RFQ desks via JupiterZ for Ondo), and `/execute` lands it. Our 1% rides as a referral
// fee Jupiter collects in USDC. Gas: the user's SOL if they hold any, Jupiter's if not; when Jupiter declines we
// become the payer ourselves (Metis only). Rent for a first-time token account is ours, once per user and mint.

const FEE_BPS = 100;
const REFERRAL_SHARE = 0.2;
const MAX_SPONSORED_PER_HOUR = 20;
const QUOTE_TTL_S = 45;
const MIN_TAKER_GAS_LAMPORTS = 2_000_000;
const ORDER_BASE = "https://api.jup.ag/swap/v2";

export const jupBase = (env: Env) => (env.JUP_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag");
export const jupHeaders = (env: Env) => ({
  "content-type": "application/json",
  ...(env.JUP_API_KEY ? { "x-api-key": env.JUP_API_KEY } : {}),
});

const resolveMint = (m: string) => (m === "usdc" ? USDC_MINT : m === "native" ? SOL_MINT : m);
const now = () => Math.floor(Date.now() / 1000);

type Order = {
  transaction: string | null;
  requestId: string;
  router: string;
  inAmount: string;
  outAmount: string;
  outUsdValue?: number;
  slippageBps?: number | string;
  rentFeeLamports?: number;
  rentFeePayer?: string;
  otherAmountThreshold: string;
  priceImpact: string;
  feeBps: number;
  gasless: boolean;
  prioritizationFeeLamports?: number;
  lastValidBlockHeight?: number | string | null;
  expireAt?: number | string | null;
  errorCode?: number | null;
  errorMessage?: string | null;
  error?: string;
};
type Executed = {
  status: "Success" | "Failed";
  signature?: string;
  code: number;
  error?: string;
  slot?: number | string;
};

type QuoteInput = {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  slippageBps?: number;
};

async function order(env: Env, params: Record<string, string>): Promise<Order> {
  const r = await fetch(`${ORDER_BASE}/order?${new URLSearchParams(params)}`, { headers: jupHeaders(env) });
  const j = (await r.json()) as Order;
  if (!r.ok || j.error) {
    const msg = (j.error ?? `${r.status}`).toLowerCase();
    throw new HttpError(422, msg.includes("route") ? "no_route" : `jupiter: ${j.error ?? r.status}`);
  }
  return j;
}

// Our Swap v2 referral account and its USDC vault (the referral account's own token account, the form Ultra
// looks for), created by the gas wallet the first time a quote needs them. Never blocks a trade.
let referralReady = false;
async function ensureReferral(env: Env): Promise<string | null> {
  const referral = ultraReferralAccount();
  if (referralReady) return referral.toBase58();
  if (!env.FEE_WALLET) return null;
  try {
    const conn = connection(env);
    const usdc = new PublicKey(USDC_MINT);
    const vault = ata(referral, usdc);
    const [acc, vaultAcc] = await conn.getMultipleAccountsInfo([referral, vault]);
    if (!acc || !vaultAcc) {
      const gas = gasKeypair(env);
      const ixs = [
        ...(acc ? [] : [initReferralAccount(gas.publicKey, new PublicKey(env.FEE_WALLET))]),
        ...(vaultAcc ? [] : [createAtaIdempotent(gas.publicKey, referral, usdc, TOKEN_PROGRAM)]),
      ];
      const { tx, lastValidBlockHeight } = await buildV0(conn, gas.publicKey, ixs, []);
      tx.sign([gas]);
      const signature = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
      await conn.confirmTransaction(
        { signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight },
        "confirmed",
      );
      console.log("referral: created", referral.toBase58(), signature);
    }
    referralReady = true;
    return referral.toBase58();
  } catch (e) {
    console.error("referral: not ready, quoting without fee", (e as Error).message);
    return null;
  }
}

// Quotes and assembles without recording anything. Shared by the real quote and the admin dry run, which opens no accounts.
async function buildOrder(env: Env, sql: Sql, q: QuoteInput) {
  const inputMint = resolveMint(q.inputMint),
    outputMint = resolveMint(q.outputMint);
  if (inputMint === outputMint) throw badRequest("inputMint and outputMint are the same");
  const side = inputMint === USDC_MINT ? "buy" : outputMint === USDC_MINT ? "sell" : null;
  if (!side) throw new HttpError(422, "usdc_only");
  const amount = BigInt(q.amount);
  if (amount <= 0n) throw badRequest("amount must be > 0");
  if (!env.GAS_WALLET_SECRET) throw new HttpError(503, "gas_wallet_not_configured");
  const tokenMint = side === "buy" ? outputMint : inputMint;
  const taker = new PublicKey(q.taker);
  const conn = connection(env);

  const [stock] = await swapsRepo.stockMeta(sql, tokenMint);
  if (!stock) throw notFound("token");
  // The issuer suspended trading in the underlying: a fill would have nothing to settle against.
  if (stock.halted) throw new HttpError(409, `trading in ${stock.symbol} is halted by the issuer`);
  if (!tradable(stock)) throw new HttpError(409, "market_closed", { opensAt: "Sunday 8pm ET" });
  const [{ feeBps: issuerFeeBps }, takerLamports, referral] = await Promise.all([
    mintInfo(conn, new PublicKey(tokenMint)),
    conn.getBalance(taker, "confirmed"),
    ensureReferral(env),
  ]);

  const base: Record<string, string> = {
    inputMint,
    outputMint,
    amount: amount.toString(),
    taker: q.taker,
    ...(q.slippageBps ? { slippageBps: String(q.slippageBps) } : {}),
    ...(referral ? { referralAccount: referral, referralFee: String(FEE_BPS) } : {}),
  };
  let o = await order(env, base);
  if (o.errorCode === 1) {
    const usdc = await conn.getTokenAccountBalance(ata(taker, new PublicKey(USDC_MINT))).catch(() => null);
    const heldUsd = Number(usdc?.value.uiAmount ?? 0);
    throw new HttpError(422, "insufficient_usdc", {
      neededUsd: side === "buy" ? Number(amount) / 1e6 : null,
      heldUsd,
      shortUsd: side === "buy" ? Math.ceil((Number(amount) / 1e6 - heldUsd) * 100) / 100 : null,
    });
  }
  // A wallet with no SOL that Jupiter will not sponsor still trades: we pay, and Jupiter routes through pools only.
  let payer: "user" | "jupiter" | "apeme" = o.gasless ? "jupiter" : "user";
  if (!o.transaction || (!o.gasless && takerLamports < MIN_TAKER_GAS_LAMPORTS)) {
    o = await order(env, { ...base, payer: gasKeypair(env).publicKey.toBase58() });
    payer = "apeme";
  }
  if (!o.transaction) throw new HttpError(422, o.errorMessage ? `jupiter: ${o.errorMessage}` : "no_route");

  // Any token account the order opens is billed by Jupiter to whoever it names; ours only on the payer fallback.
  const rentLamports = Number(o.rentFeeLamports ?? 0);
  const rentPaidBy = !rentLamports
    ? null
    : o.rentFeePayer === q.taker
      ? "user"
      : payer === "apeme"
        ? "apeme"
        : "jupiter";
  const tx = VersionedTransaction.deserialize(Buffer.from(o.transaction, "base64"));
  const msgHash = await sha256hex(tx.message.serialize());
  const feeRaw = referral
    ? ((side === "buy" ? amount : BigInt(o.outAmount)) * BigInt(FEE_BPS)) / 10_000n
    : 0n;
  // Jupiter's feeBps is the whole charge; with our referral on, it is our 1% (Jupiter keeps 20% of it).
  const routerFeeBps = Math.max(o.feeBps - (feeRaw > 0n ? FEE_BPS : 0), 0);
  const inUsd = side === "buy" ? Number(amount) / 1e6 : Number(o.outAmount) / 1e6;
  const issuerFeeUsd = Math.round(inUsd * issuerFeeBps) / 10_000;
  // `outAmount` is already net of Jupiter's cut and ours (both taken in USDC); what the user actually gets.
  const outUsd =
    (side === "buy" ? Number(o.outUsdValue ?? inUsd - Number(feeRaw) / 1e6) : Number(o.outAmount) / 1e6) -
    issuerFeeUsd;
  return {
    o,
    tx,
    msgHash,
    side,
    inputMint,
    outputMint,
    amount,
    feeRaw,
    routerFeeBps,
    inUsd,
    outUsd,
    issuerFeeBps,
    issuerFeeUsd,
    payer,
    rentLamports,
    rentPaidBy,
    stock,
    feePayer: tx.message.staticAccountKeys[0]!.toBase58(),
  };
}

const DEPTH_LEVELS = [100, 1_000, 10_000] as const;

// What a buy of each size costs in price impact. Thin pools punish size, and the app should say so before the sheet.
export async function depth(env: Env, sql: Sql, mint: string) {
  const symbol = (await swapsRepo.stockMeta(sql, mint))[0]?.symbol;
  if (symbol === undefined) throw notFound("token");
  const levels = await Promise.all(
    DEPTH_LEVELS.map(async (usd) => {
      const o = await order(env, { inputMint: USDC_MINT, outputMint: mint, amount: String(usd * 1e6) }).catch(
        () => null,
      );
      return { usd, impactPct: o ? Math.round(Number(o.priceImpact) * 100) / 100 : null };
    }),
  );
  return { mint, symbol, levels, asOf: now() };
}

export async function quote(
  env: Env,
  sql: Sql,
  user: UserRow,
  wallets: WalletRow[],
  settings: SettingsRow,
  q: QuoteInput,
) {
  if (!wallets.some((w) => w.address === q.taker && w.chain === "solana"))
    throw new HttpError(403, "taker is not one of your wallets");
  // Slippage 0 in settings means auto: Jupiter sizes it per token (ultra mode), which fee-on-transfer names need.
  const b = await buildOrder(env, sql, {
    ...q,
    slippageBps: q.slippageBps ?? (settings.slippage_bps || undefined),
  });
  const { o, side, inputMint, outputMint, amount, feeRaw, inUsd, outUsd, stock } = b;
  const id = crypto.randomUUID();
  const t = now();
  const priceImpactPct = Number(o.priceImpact);
  const premiumPct = stock.premium_pct == null ? null : Number(stock.premium_pct);
  await swapsRepo.insertQuote(sql, {
    id,
    userId: user.id,
    wallet: q.taker,
    side,
    inputMint,
    outputMint,
    symbol: stock.symbol,
    inRaw: amount.toString(),
    outRaw: o.outAmount,
    minOutRaw: o.otherAmountThreshold,
    inUsd,
    outUsd,
    feeBps: feeRaw > 0n ? FEE_BPS : 0,
    feeRaw: feeRaw.toString(),
    feeUsd: Number(feeRaw) / 1e6,
    priceImpactPct,
    premiumPct,
    payer: b.payer,
    router: o.router,
    requestId: o.requestId,
    gasLamports: b.payer === "apeme" ? (o.prioritizationFeeLamports ?? 0) + 5000 * 2 : 0,
    rentLamports: b.rentPaidBy === "apeme" ? b.rentLamports : 0,
    swapUsd: inUsd,
    issuerFeeUsd: b.issuerFeeUsd,
    msgHash: b.msgHash,
    lastValidBlockHeight: Number(o.lastValidBlockHeight ?? 0),
    t,
  });
  return {
    requestId: id,
    side,
    inputMint,
    outputMint,
    symbol: stock.symbol,
    inAmount: amount.toString(),
    outAmount: o.outAmount,
    minOut: o.otherAmountThreshold,
    inDecimals: side === "buy" ? 6 : stock.decimals,
    outDecimals: side === "buy" ? stock.decimals : 6,
    multiplier: Number(stock.multiplier ?? 1),
    inUsd,
    outUsd,
    totalUsd: inUsd,
    priceImpactPct,
    slippageBps: Number(o.slippageBps ?? q.slippageBps ?? 0),
    fee: {
      bps: feeRaw > 0n ? FEE_BPS : 0,
      amountRaw: feeRaw.toString(),
      mint: USDC_MINT,
      usd: Number(feeRaw) / 1e6,
    },
    routerFeeBps: b.routerFeeBps,
    router: o.router,
    issuerFee: b.issuerFeeBps
      ? { bps: b.issuerFeeBps, usd: b.issuerFeeUsd, note: "charged by the token issuer on every transfer" }
      : null,
    rent: { lamports: b.rentLamports, paidBy: b.rentPaidBy },
    gas: { paidBy: b.payer, lamports: o.prioritizationFeeLamports ?? 0 },
    premiumPct,
    markUsd: stock.mark_usd == null ? null : Number(stock.mark_usd),
    transaction: o.transaction,
    signers: { feePayer: b.feePayer, user: q.taker },
    expiresAt: Math.min(t + QUOTE_TTL_S, Number(o.expireAt ?? Infinity)),
  };
}

const verifyEd25519 = async (pub: Uint8Array, sig: Uint8Array, msg: Uint8Array) => {
  const key = await crypto.subtle.importKey("raw", u8(pub), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, u8(sig), u8(msg));
};

// A signed transaction is only ours if it is byte-for-byte the one we quoted and the user really signed it.
export async function signedByUser(signedTransaction: string, wallet: string, msgHash: string | null) {
  let tx: VersionedTransaction;
  try {
    tx = VersionedTransaction.deserialize(Buffer.from(signedTransaction, "base64"));
  } catch {
    throw badRequest("signedTransaction is not a valid transaction");
  }
  const msgBytes = tx.message.serialize();
  if ((await sha256hex(msgBytes)) !== msgHash)
    throw new HttpError(422, "transaction does not match the quote");
  const keys = tx.message.staticAccountKeys;
  const i = keys.findIndex((k) => k.toBase58() === wallet);
  const sig = i >= 0 ? tx.signatures[i] : undefined;
  if (!sig || sig.every((b) => b === 0) || !(await verifyEd25519(keys[i]!.toBytes(), sig, msgBytes)))
    throw new HttpError(422, "missing or invalid user signature");
  return tx;
}

// Bookkeeping once a swap is on-chain: the referrer's cut of our fee, once per confirmed swap.
async function settle(
  sql: Sql,
  row: { id: string; user_id: string; fee_usd: number | null; in_usd: number | null },
  slot: number,
  blockTime: number,
  t: number,
) {
  const [done] = await swapsRepo.markConfirmed(sql, row.id, slot, blockTime);
  if (!done) return;
  const [ref] = await swapsRepo.referrerOf(sql, row.user_id);
  if (ref && Number(row.fee_usd) > 0 && Number(row.in_usd) >= 5)
    await swapsRepo.accrueReferral(
      sql,
      crypto.randomUUID(),
      ref.referrer_user_id,
      row.user_id,
      row.id,
      Number(row.fee_usd) * REFERRAL_SHARE,
      t,
    );
}

export async function submit(
  env: Env,
  sql: Sql,
  user: UserRow,
  requestId: string,
  signedTransaction: string,
) {
  const [row] = await swapsRepo.byId(sql, requestId, user.id);
  if (!row) throw notFound("quote");
  if (row.status !== "quoted") throw new HttpError(409, `quote already ${row.status}`);
  const t = now();
  if (t > Number(row.created_at) + QUOTE_TTL_S) {
    await swapsRepo.markFailed(sql, row.id, "quote_expired");
    throw new HttpError(410, "quote_expired");
  }
  const n = Number((await swapsRepo.sponsoredLastHour(sql, user.id, t - 3600))[0]?.n ?? 0);
  if (n >= MAX_SPONSORED_PER_HOUR) throw new HttpError(429, "too many trades this hour");

  const tx = await signedByUser(signedTransaction, row.wallet, row.msg_hash);
  if (row.payer === "apeme") tx.sign([gasKeypair(env)]);
  const signed = Buffer.from(tx.serialize()).toString("base64");
  const r = await fetch(`${ORDER_BASE}/execute`, {
    method: "POST",
    headers: jupHeaders(env),
    body: JSON.stringify({ signedTransaction: signed, requestId: row.jup_request_id }),
  });
  const x = (await r.json()) as Executed;
  if (x.status !== "Success" || !x.signature) {
    const err = `${x.code ?? r.status}: ${x.error ?? "execute failed"}`.slice(0, 300);
    await swapsRepo.markFailed(sql, row.id, err);
    if (x.code === -2003 || x.code === -1004) throw new HttpError(410, "quote_expired");
    throw new HttpError(422, /slippage|0x1771|6001/i.test(err) ? "slippage" : `execute failed: ${err}`);
  }
  await swapsRepo.markSubmitted(sql, row.id, x.signature, signed, t);
  await settle(sql, { ...row, id: row.id }, Number(x.slot ?? 0), t, t);
  return {
    signature: x.signature,
    status: "confirmed" as const,
    requestId: row.id,
    slot: Number(x.slot ?? 0),
  };
}

// Status by signature, for polling. `/execute` already confirms, so this mostly reports; it still settles a
// submitted row the chain confirmed after an execute timeout.
export async function txStatus(env: Env, sql: Sql, signature: string) {
  const conn = connection(env);
  const [st] = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value;
  const [row] = await swapsRepo.bySignature(sql, signature);
  const t = now();
  if (!st || st.confirmationStatus === "processed") return { signature, status: "pending" as const };
  if (st.err) {
    if (row && row.status === "submitted")
      await swapsRepo.markFailed(sql, row.id, JSON.stringify(st.err).slice(0, 300));
    return { signature, status: "failed" as const, slot: st.slot, error: JSON.stringify(st.err) };
  }
  if (row && row.status === "submitted") {
    const blockTime = (await conn.getBlockTime(st.slot).catch(() => null)) ?? Number(row.submitted_at ?? t);
    await settle(sql, row, st.slot, blockTime, t);
  }
  return { signature, status: "confirmed" as const, slot: st.slot, confirmations: st.confirmationStatus };
}

// Ops: our gas wallet as the chain sees it. Address is derived from the secret; the secret itself never leaves memory.
export async function gasInfo(env: Env) {
  const gas = gasKeypair(env);
  const conn = connection(env);
  const lamports = await conn.getBalance(gas.publicKey, "confirmed");
  return {
    address: gas.publicKey.toBase58(),
    sol: lamports / 1e9,
    feeWallet: env.FEE_WALLET ?? null,
    ultraReferral: ultraReferralAccount().toBase58(),
  };
}

// Ops: assemble a real order for any funded wallet without recording or signing. Proves routing, fees and gas.
export async function simulate(env: Env, sql: Sql, q: QuoteInput) {
  const b = await buildOrder(env, sql, q);
  return {
    side: b.side,
    symbol: b.stock.symbol,
    router: b.o.router,
    gasless: b.o.gasless,
    payer: b.payer,
    feePayer: b.feePayer,
    inAmount: b.amount.toString(),
    outAmount: b.o.outAmount,
    routerFeeBps: b.routerFeeBps,
    feeRaw: b.feeRaw.toString(),
    inUsd: b.inUsd,
    outUsd: b.outUsd,
    rentLamports: b.rentLamports,
    rentPaidBy: b.rentPaidBy,
    txBytes: b.tx.serialize().length,
  };
}
