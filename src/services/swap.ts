import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import {
  USDC_MINT,
  SOL_MINT,
  TOKEN_PROGRAM,
  ATA_PROGRAM,
  ATA_RENT_LAMPORTS,
  connection,
  gasKeypair,
  ata,
  transferChecked,
  createAtaIdempotent,
  fromJup,
  lookupTables,
  transferFeeBps,
  buildV0,
  sha256hex,
  u8,
  type JupIx,
} from "../lib/solana";
import { swapsRepo } from "../repos/swaps";
import { solPrice as solUsd } from "../lib/rpc";
import type { UserRow, WalletRow, SettingsRow } from "../repos/account";

// USDC-only trading. Buys: typed amount = total debit (fee + rent inside). Sells: fee off the USDC out. We pay gas.

const FEE_BPS = 100;
const REFERRAL_SHARE = 0.2;
const MAX_SPONSORED_PER_HOUR = 20;
const QUOTE_TTL_S = 45;
const PRIORITY = {
  normal: { priorityLevel: "medium", maxLamports: 100_000 },
  fast: { priorityLevel: "high", maxLamports: 1_000_000 },
  turbo: { priorityLevel: "veryHigh", maxLamports: 5_000_000 },
} as const;
const TURBO_MIN_USD = 50;

export const jupBase = (env: Env) => (env.JUP_API_KEY ? "https://api.jup.ag" : "https://lite-api.jup.ag");
export const jupHeaders = (env: Env) => ({
  "content-type": "application/json",
  ...(env.JUP_API_KEY ? { "x-api-key": env.JUP_API_KEY } : {}),
});

const resolveMint = (m: string) => (m === "usdc" ? USDC_MINT : m === "native" ? SOL_MINT : m);
const now = () => Math.floor(Date.now() / 1000);

type JupQuote = {
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  priceImpactPct: string;
  swapUsdValue?: string;
  slippageBps: number;
  routePlan: unknown[];
  error?: string;
  errorCode?: string;
};
type JupIxs = {
  computeBudgetInstructions: JupIx[];
  setupInstructions: JupIx[];
  swapInstruction: JupIx;
  cleanupInstruction: JupIx | null;
  otherInstructions?: JupIx[];
  addressLookupTableAddresses: string[];
  prioritizationFeeLamports?: number;
  error?: string;
};

type QuoteInput = {
  inputMint: string;
  outputMint: string;
  amount: string;
  taker: string;
  slippageBps?: number;
  priority?: "normal" | "fast" | "turbo";
};

// Builds the full transaction for a quote without recording anything. Shared by the real quote and the admin simulator.
async function buildTx(
  env: Env,
  sql: Sql,
  q: QuoteInput,
  defaults: { slippageBps: number; priority: string },
) {
  const inputMint = resolveMint(q.inputMint),
    outputMint = resolveMint(q.outputMint);
  if (inputMint === outputMint) throw badRequest("inputMint and outputMint are the same");
  const side = inputMint === USDC_MINT ? "buy" : outputMint === USDC_MINT ? "sell" : null;
  if (!side) throw new HttpError(422, "usdc_only");
  const amount = BigInt(q.amount);
  if (amount <= 0n) throw badRequest("amount must be > 0");
  if (!env.GAS_WALLET_SECRET || !env.FEE_WALLET) throw new HttpError(503, "gas_wallet_not_configured");
  const slippageBps = q.slippageBps ?? defaults.slippageBps;
  let priority = (q.priority ?? defaults.priority) as keyof typeof PRIORITY;
  const tokenMint = side === "buy" ? outputMint : inputMint;
  const gas = gasKeypair(env);
  const taker = new PublicKey(q.taker);
  const conn = connection(env);

  // Buys: the typed amount is what the user receives. Our fee and the one-off account rent go on top, and
  // the sheet shows the total before they sign. Sells are unchanged: the fee comes off the proceeds.
  const tokenPk = new PublicKey(tokenMint);
  const usdcPk = new PublicKey(USDC_MINT);
  const [[stockRows, memeRows], solUsdNow, usdcInfo, issuerFeeBps] = await Promise.all([
    Promise.all([swapsRepo.stockMeta(sql, tokenMint), swapsRepo.tokenMeta(sql, tokenMint)]),
    solUsd(),
    side === "buy" ? conn.getAccountInfo(ata(taker, usdcPk)) : Promise.resolve(null),
    transferFeeBps(conn, tokenPk),
  ]);
  // Jupiter quotes before the mint's own transfer fee, so the fee must sit inside the slippage or every fill misses minOut.
  const jupSlippageBps = slippageBps + issuerFeeBps;
  const stock = stockRows[0];
  const meme = stock ? null : memeRows[0];
  if (!stock && !meme) throw notFound("token");
  const symbol = stock?.symbol ?? meme?.symbol ?? null;
  const lamportsToUsd = (l: number) => (solUsdNow ? Math.ceil((l / 1e9) * solUsdNow * 100) / 100 : 0);
  const feeOnInput = side === "buy" ? (amount * BigInt(FEE_BPS)) / 10_000n : 0n;

  // Prefer direct routes for stocks (no intermediate token accounts) unless multi-hop pays >0.5% more.
  const getQuote = async (swapAmount: bigint, direct: boolean) => {
    const r = await fetch(
      `${jupBase(env)}/swap/v1/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${swapAmount}&slippageBps=${jupSlippageBps}&restrictIntermediateTokens=true${direct ? "&onlyDirectRoutes=true" : ""}`,
      { headers: jupHeaders(env) },
    );
    const j = (await r.json()) as JupQuote;
    return { ok: r.ok && !j.error, status: r.status, j };
  };
  const route = async (swapAmount: bigint) => {
    if (swapAmount <= 0n) throw new HttpError(422, "amount_too_small");
    const [multi, direct] = await Promise.all([
      getQuote(swapAmount, false),
      stock ? getQuote(swapAmount, true) : null,
    ]);
    if (!multi.ok) {
      const msg = (multi.j.error ?? "").toLowerCase();
      throw new HttpError(
        422,
        msg.includes("route")
          ? "no_route"
          : msg.includes("amount")
            ? "amount_too_small"
            : `jupiter: ${multi.j.error ?? multi.status}`,
      );
    }
    const jqj =
      direct?.ok && Number(direct.j.outAmount) >= Number(multi.j.outAmount) * 0.995 ? direct.j : multi.j;
    const ir = await fetch(`${jupBase(env)}/swap/v1/swap-instructions`, {
      method: "POST",
      headers: jupHeaders(env),
      body: JSON.stringify({
        quoteResponse: jqj,
        userPublicKey: q.taker,
        wrapAndUnwrapSol: false,
        dynamicComputeUnitLimit: true,
        prioritizationFeeLamports: { priorityLevelWithMaxLamports: { ...PRIORITY[priority], global: false } },
      }),
    });
    const ixs = (await ir.json()) as JupIxs;
    if (!ir.ok || ixs.error) throw new HttpError(422, `jupiter: ${ixs.error ?? ir.status}`);
    // Accounts the route really opens: we front the SOL, the user pays the same value in USDC.
    const setupAll = ixs.setupInstructions.map(fromJup);
    const ataIxs = setupAll.filter((t) => t.programId.equals(ATA_PROGRAM) && t.keys[1]);
    const [existing, alts] = await Promise.all([
      ataIxs.length
        ? conn.getMultipleAccountsInfo(ataIxs.map((t) => t.keys[1]!.pubkey))
        : Promise.resolve([]),
      lookupTables(conn, ixs.addressLookupTableAddresses),
    ]);
    let lamports = 0;
    const rentMints: string[] = [];
    const setup = setupAll.filter((t) => {
      if (!t.programId.equals(ATA_PROGRAM) || !t.keys[0]) return true;
      if (existing[ataIxs.indexOf(t)]) return false;
      t.keys[0] = { pubkey: gas.publicKey, isSigner: true, isWritable: true };
      lamports += ATA_RENT_LAMPORTS;
      rentMints.push(t.keys[3]?.pubkey.toBase58() ?? "");
      return true;
    });
    return { jqj, ixs, setup, alts, lamports, rentMints };
  };

  // The route itself names every account it has to open, so one pass settles both the swap and the rent.
  const r = await route(amount);
  const { jqj, ixs, setup, alts, rentMints } = r;
  const rentLamports = side === "buy" ? r.lamports : 0;
  const rentRaw = BigInt(Math.round(lamportsToUsd(rentLamports) * 1e6));
  const rentUsd = Number(rentRaw) / 1e6;
  const totalRaw = side === "buy" ? amount + feeOnInput + rentRaw : amount;
  if (side === "buy") {
    const held = usdcInfo
      ? new DataView(usdcInfo.data.buffer, usdcInfo.data.byteOffset).getBigUint64(64, true)
      : 0n;
    if (held < totalRaw)
      throw new HttpError(422, "insufficient_usdc", {
        neededUsd: Number(totalRaw) / 1e6,
        heldUsd: Number(held) / 1e6,
        shortUsd: Math.ceil(Number(totalRaw - held) / 10_000) / 100,
      });
  }

  const minOut = BigInt(jqj.otherAmountThreshold);
  const feeOnOutput = side === "sell" ? (minOut * BigInt(FEE_BPS)) / 10_000n : 0n;
  const feeRaw = side === "buy" ? feeOnInput : feeOnOutput;
  const swapUsd = Number(jqj.swapUsdValue ?? 0);
  const inUsd = side === "buy" ? Number(totalRaw) / 1e6 : swapUsd;
  const issuerFeeUsd = Math.round(swapUsd * issuerFeeBps) / 10_000;
  const outUsd =
    (side === "buy" ? swapUsd : Number(BigInt(jqj.outAmount) - feeOnOutput) / 1e6) - issuerFeeUsd;
  if (priority === "turbo" && inUsd < TURBO_MIN_USD) priority = "fast";

  const usdcMint = new PublicKey(USDC_MINT),
    feeWallet = new PublicKey(env.FEE_WALLET);
  const chargeRaw = feeRaw + rentRaw;
  const feeIx =
    chargeRaw > 0n
      ? [
          createAtaIdempotent(gas.publicKey, feeWallet, usdcMint, TOKEN_PROGRAM),
          transferChecked(
            ata(taker, usdcMint),
            usdcMint,
            ata(feeWallet, usdcMint),
            taker,
            chargeRaw,
            6,
            TOKEN_PROGRAM,
          ),
        ]
      : [];
  const all = [
    ...ixs.computeBudgetInstructions.map(fromJup),
    ...setup,
    ...(side === "buy" ? feeIx : []),
    fromJup(ixs.swapInstruction),
    ...(ixs.cleanupInstruction ? [fromJup(ixs.cleanupInstruction)] : []),
    ...(side === "sell" ? feeIx : []),
    ...(ixs.otherInstructions ?? []).map(fromJup),
  ];
  const { tx, lastValidBlockHeight } = await buildV0(conn, gas.publicKey, all, alts);
  const msgBytes = tx.message.serialize();
  const msgHash = await sha256hex(msgBytes);
  const gasLamports = (ixs.prioritizationFeeLamports ?? 0) + 5000 * 2;
  const premiumPct = stock?.premium_pct == null ? null : Number(stock.premium_pct);
  const tokenDecimals = stock?.decimals ?? meme?.decimals ?? 6,
    multiplier = stock ? Number(stock.multiplier ?? 1) : 1;
  return {
    tokenDecimals,
    multiplier,
    issuerFeeBps,
    issuerFeeUsd,
    rentUsd,
    rentRaw,
    tx,
    msgHash,
    lastValidBlockHeight,
    gasLamports,
    rentLamports,
    rentMints,
    side,
    inputMint,
    outputMint,
    symbol,
    amount,
    totalRaw,
    jqj,
    minOut,
    feeRaw,
    inUsd,
    outUsd,
    slippageBps,
    priority,
    premiumPct,
    stock,
    gasPubkey: gas.publicKey.toBase58(),
  };
}

const DEPTH_LEVELS = [100, 1_000, 10_000] as const;

// What a buy of each size costs in price impact. Thin pools punish size, and the app should say so before the sheet.
export async function depth(env: Env, sql: Sql, mint: string) {
  const [stockRows, memeRows] = await Promise.all([
    swapsRepo.stockMeta(sql, mint),
    swapsRepo.tokenMeta(sql, mint),
  ]);
  const symbol = stockRows[0]?.symbol ?? memeRows[0]?.symbol;
  if (symbol === undefined) throw notFound("token");
  const levels = await Promise.all(
    DEPTH_LEVELS.map(async (usd) => {
      const r = await fetch(
        `${jupBase(env)}/swap/v1/quote?inputMint=${USDC_MINT}&outputMint=${mint}&amount=${usd * 1e6}&slippageBps=100&restrictIntermediateTokens=true`,
        { headers: jupHeaders(env) },
      );
      if (!r.ok) return { usd, impactPct: null };
      const j = (await r.json()) as { priceImpactPct: string };
      return { usd, impactPct: Math.round(Number(j.priceImpactPct) * 10_000) / 100 };
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
  const b = await buildTx(env, sql, q, { slippageBps: settings.slippage_bps, priority: settings.priority });
  const {
    tx,
    msgHash,
    lastValidBlockHeight,
    gasLamports,
    rentLamports,
    rentMints,
    side,
    inputMint,
    outputMint,
    symbol,
    amount,
    totalRaw,
    jqj,
    minOut,
    feeRaw,
    inUsd,
    outUsd,
    slippageBps,
    priority,
    premiumPct,
    stock,
  } = b;
  const id = crypto.randomUUID();
  const t = now();
  await swapsRepo.insertQuote(sql, {
    id,
    userId: user.id,
    wallet: q.taker,
    side,
    inputMint,
    outputMint,
    symbol,
    inRaw: amount.toString(),
    outRaw: jqj.outAmount,
    minOutRaw: minOut.toString(),
    inUsd,
    outUsd,
    feeBps: FEE_BPS,
    feeRaw: feeRaw.toString(),
    feeUsd: Number(feeRaw) / 1e6,
    priceImpactPct: Number(jqj.priceImpactPct) * 100,
    premiumPct,
    priority,
    gasLamports,
    rentLamports,
    swapUsd: side === "buy" ? Number(amount) / 1e6 : inUsd,
    rentUsd: b.rentUsd,
    issuerFeeUsd: b.issuerFeeUsd,
    msgHash,
    lastValidBlockHeight,
    t,
  });
  return {
    requestId: id,
    side,
    inputMint,
    outputMint,
    symbol,
    inAmount: amount.toString(),
    outAmount: jqj.outAmount,
    minOut: minOut.toString(),
    inDecimals: side === "buy" ? 6 : b.tokenDecimals,
    outDecimals: side === "buy" ? b.tokenDecimals : 6,
    multiplier: b.multiplier,
    inUsd,
    outUsd,
    totalUsd: Number(totalRaw) / 1e6,
    priceImpactPct: Number(jqj.priceImpactPct) * 100,
    slippageBps,
    suggestedSlippageBps: Math.min(500, Math.max(50, Math.ceil(Number(jqj.priceImpactPct) * 10_000) + 50)),
    fee: { bps: FEE_BPS, amountRaw: feeRaw.toString(), mint: USDC_MINT, usd: Number(feeRaw) / 1e6 },
    issuerFee: b.issuerFeeBps
      ? { bps: b.issuerFeeBps, usd: b.issuerFeeUsd, note: "charged by the token issuer on every transfer" }
      : null,
    rent: {
      accounts: b.rentMints.length,
      lamports: rentLamports,
      usd: b.rentUsd,
      amountRaw: b.rentRaw.toString(),
      paidBy: "user",
      note: b.rentUsd > 0 ? "one-time network fee to open the token account, charged in USDC" : null,
    },
    totalChargeUsd: (Number(feeRaw) + Number(b.rentRaw)) / 1e6,
    swapUsd: side === "buy" ? Number(amount) / 1e6 : inUsd,
    gas: { paidBy: "apeme", priority, lamports: gasLamports, rentLamports },
    premiumPct,
    markUsd: stock?.mark_usd == null ? null : Number(stock.mark_usd),
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    signers: { feePayer: b.gasPubkey, user: q.taker },
    expiresAt: t + QUOTE_TTL_S,
    _rentMints: rentMints,
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
  const gas = gasKeypair(env);
  tx.sign([gas]);
  const conn = connection(env);
  let sig: string;
  try {
    sig = await conn.sendRawTransaction(tx.serialize(), {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
  } catch (e) {
    const msg = (e as Error).message;
    await swapsRepo.markFailed(sql, row.id, msg.slice(0, 300));
    if (/blockhash not found/i.test(msg)) throw new HttpError(410, "quote_expired");
    throw new HttpError(
      422,
      /slippage|0x1771|6001/i.test(msg)
        ? "slippage"
        : /insufficient|0x1\b|InsufficientFunds/i.test(msg)
          ? "insufficient_funds"
          : `send failed: ${msg.slice(0, 120)}`,
    );
  }
  await swapsRepo.markSubmitted(sql, row.id, sig, Buffer.from(tx.serialize()).toString("base64"), t);
  return { signature: sig, status: "submitted" as const, requestId: row.id };
}

// Status by signature. Also settles our bookkeeping: confirmed → referral accrual, failed/expired → marked.
export async function txStatus(env: Env, sql: Sql, signature: string) {
  const conn = connection(env);
  const [st] = (await conn.getSignatureStatuses([signature], { searchTransactionHistory: true })).value;
  const [row] = await swapsRepo.bySignature(sql, signature);
  const t = now();
  // Not seen, or only processed (can still be dropped): rebroadcast while the blockhash is alive.
  if (!st || st.confirmationStatus === "processed") {
    if (
      !st &&
      row?.last_valid_block_height &&
      (await conn.getBlockHeight("confirmed")) > Number(row.last_valid_block_height)
    ) {
      if (row.status === "submitted") await swapsRepo.markFailed(sql, row.id, "expired");
      return { signature, status: "failed" as const, error: "expired" };
    }
    if (row?.status === "submitted" && row.signed_tx)
      await conn
        .sendRawTransaction(Buffer.from(row.signed_tx, "base64"), { skipPreflight: true, maxRetries: 0 })
        .catch(() => {});
    return { signature, status: "pending" as const };
  }
  if (st.err) {
    if (row && row.status === "submitted")
      await swapsRepo.markFailed(sql, row.id, JSON.stringify(st.err).slice(0, 300));
    return { signature, status: "failed" as const, slot: st.slot, error: JSON.stringify(st.err) };
  }
  if (row && row.status === "submitted") {
    const blockTime = (await conn.getBlockTime(st.slot).catch(() => null)) ?? Number(row.submitted_at ?? t);
    const [done] = await swapsRepo.markConfirmed(sql, row.id, st.slot, blockTime);
    if (done) {
      if (Number(row.rent_lamports) > 0)
        await swapsRepo.recordRent(
          sql,
          row.user_id,
          row.side === "buy" ? row.output_mint : row.input_mint,
          Number(row.rent_lamports),
          t,
        );
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
  }
  return { signature, status: "confirmed" as const, slot: st.slot, confirmations: st.confirmationStatus };
}

// Ops: our gas wallet as the chain sees it. Address is derived from the secret; the secret itself never leaves memory.
export async function gasInfo(env: Env) {
  const gas = gasKeypair(env);
  const conn = connection(env);
  const lamports = await conn.getBalance(gas.publicKey, "confirmed");
  return { address: gas.publicKey.toBase58(), sol: lamports / 1e9, feeWallet: env.FEE_WALLET ?? null };
}

// Ops: build a real swap tx for any funded wallet and simulate it (no signatures, no money). Proves the whole path.
export async function simulate(env: Env, sql: Sql, q: QuoteInput) {
  const b = await buildTx(env, sql, q, { slippageBps: 100, priority: "normal" });
  const conn = connection(env);
  const sim = await conn.simulateTransaction(b.tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  return {
    ok: !sim.value.err,
    err: sim.value.err,
    unitsConsumed: sim.value.unitsConsumed,
    logs: (sim.value.logs ?? []).slice(-12),
    side: b.side,
    symbol: b.symbol,
    inAmount: b.amount.toString(),
    outAmount: b.jqj.outAmount,
    feeRaw: b.feeRaw.toString(),
    inUsd: b.inUsd,
    outUsd: b.outUsd,
    gasLamports: b.gasLamports,
    rentLamports: b.rentLamports,
    rentUsd: b.rentUsd,
    rentAccounts: b.rentMints.length,
    feePayer: b.gasPubkey,
    txBytes: b.tx.serialize().length,
  };
}
