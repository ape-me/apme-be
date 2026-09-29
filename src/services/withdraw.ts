import { PublicKey, SystemProgram } from "@solana/web3.js";
import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { HttpError, badRequest, notFound } from "../lib/errors";
import {
  USDC_MINT,
  SOL_MINT,
  ATA_RENT_LAMPORTS,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  connection,
  gasKeypair,
  ata,
  createAtaIdempotent,
  transferChecked,
  mintInfo,
  buildV0,
  sha256hex,
} from "../lib/solana";
import { solPrice } from "../lib/rpc";
import { swapsRepo } from "../repos/swaps";
import { withdrawalsRepo } from "../repos/withdrawals";
import type { UserRow, WalletRow } from "../repos/account";
import { signedByUser } from "./swap";

const QUOTE_TTL_S = 60;
const MAX_PER_HOUR = 20;
const MIN_USDC_RAW = 1_000_000n;
const SYSTEM_RENT_LAMPORTS = 890_880n; // a fresh wallet must land rent-exempt or the transfer fails
const now = () => Math.floor(Date.now() / 1000);

type WithdrawInput = { from: string; mint: string; amount: string; to: string };

// Builds a transfer the user signs and we pay for. Recipient gets its token account opened on our SOL if needed.
export async function quote(env: Env, sql: Sql, user: UserRow, wallets: WalletRow[], q: WithdrawInput) {
  if (!wallets.some((w) => w.chain === "solana" && w.address === q.from)) throw notFound("wallet");
  if (q.to === q.from) throw badRequest("to is the sending wallet");
  const amount = BigInt(q.amount);
  if (amount <= 0n) throw badRequest("amount must be > 0");
  if (!env.GAS_WALLET_SECRET) throw new HttpError(503, "gas_wallet_not_configured");
  const mint = q.mint === "usdc" ? USDC_MINT : q.mint === "native" ? SOL_MINT : q.mint;
  if (mint === USDC_MINT && amount < MIN_USDC_RAW) throw new HttpError(422, "min_amount", { minUsd: 1 });
  const conn = connection(env);
  const from = new PublicKey(q.from),
    to = new PublicKey(q.to),
    gas = gasKeypair(env);

  // A token account as recipient would burn the funds: the address must be a wallet (or a program-owned vault).
  const toInfo = await conn.getAccountInfo(to);
  if (toInfo && (toInfo.owner.equals(TOKEN_PROGRAM) || toInfo.owner.equals(TOKEN_2022_PROGRAM)))
    throw new HttpError(422, "token_account_address");

  let symbol: string | null,
    decimals: number,
    usd: number | null,
    rentLamports = 0,
    ixs;
  if (mint === SOL_MINT) {
    const held = await conn.getBalance(from, "confirmed");
    if (BigInt(held) < amount) throw new HttpError(422, "insufficient_balance", { heldRaw: String(held) });
    if (!toInfo && amount < SYSTEM_RENT_LAMPORTS)
      throw new HttpError(422, "min_amount", { minRaw: SYSTEM_RENT_LAMPORTS.toString() });
    symbol = "SOL";
    decimals = 9;
    usd = (((await solPrice()) ?? 0) * Number(amount)) / 1e9 || null;
    ixs = [SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports: amount })];
  } else {
    const m = new PublicKey(mint);
    const info = await mintInfo(conn, m).catch(() => null);
    if (!info) throw notFound("token");
    if (info.hooked) throw new HttpError(422, "unsupported_token");
    const src = ata(from, m, info.program),
      dst = ata(to, m, info.program);
    const [bal, dstInfo, stock] = await Promise.all([
      conn.getTokenAccountBalance(src, "confirmed").catch(() => null),
      conn.getAccountInfo(dst),
      mint === USDC_MINT ? [] : swapsRepo.stockMeta(sql, mint),
    ]);
    const held = BigInt(bal?.value.amount ?? "0");
    if (held < amount) throw new HttpError(422, "insufficient_balance", { heldRaw: held.toString() });
    decimals = info.decimals;
    issuerFeeBps = info.feeBps;
    symbol = mint === USDC_MINT ? "USDC" : (stock[0]?.symbol ?? null);
    const px = mint === USDC_MINT ? 1 : stock[0]?.price_usd;
    usd = px ? Math.round((Number(amount) / 10 ** decimals) * px * 100) / 100 : null;
    if (!dstInfo) rentLamports = ATA_RENT_LAMPORTS;
    ixs = [
      ...(dstInfo ? [] : [createAtaIdempotent(gas.publicKey, to, m, info.program)]),
      transferChecked(src, m, dst, from, amount, decimals, info.program),
    ];
  }
  const { tx } = await buildV0(conn, gas.publicKey, ixs, []);
  const id = crypto.randomUUID(),
    t = now();
  await withdrawalsRepo.insert(sql, {
    id,
    userId: user.id,
    wallet: q.from,
    to: q.to,
    mint,
    symbol,
    amountRaw: amount.toString(),
    decimals,
    usd,
    rentLamports,
    msgHash: await sha256hex(tx.message.serialize()),
    t,
  });
  return {
    requestId: id,
    from: q.from,
    to: q.to,
    mint,
    symbol,
    amount: amount.toString(),
    decimals,
    usd,
    fee: { bps: 0, usd: 0 },
    issuerFeeBps,
    gas: { paidBy: "apeme" as const },
    rent: { lamports: rentLamports, paidBy: "apeme" as const },
    transaction: Buffer.from(tx.serialize()).toString("base64"),
    signers: { feePayer: gas.publicKey.toBase58(), user: q.from },
    expiresAt: t + QUOTE_TTL_S,
  };
}

export async function submit(
  env: Env,
  sql: Sql,
  user: UserRow,
  requestId: string,
  signedTransaction: string,
) {
  const [row] = await withdrawalsRepo.byId(sql, requestId, user.id);
  if (!row) throw notFound("withdrawal");
  if (row.status !== "quoted") throw new HttpError(409, `withdrawal already ${row.status}`);
  const t = now();
  if (t > Number(row.created_at) + QUOTE_TTL_S) {
    await withdrawalsRepo.markFailed(sql, row.id, "quote_expired");
    throw new HttpError(410, "quote_expired");
  }
  const n = Number((await withdrawalsRepo.sentLastHour(sql, user.id, t - 3600))[0]?.n ?? 0);
  if (n >= MAX_PER_HOUR) throw new HttpError(429, "too many withdrawals this hour");

  const tx = await signedByUser(signedTransaction, row.wallet, row.msg_hash);
  tx.sign([gasKeypair(env)]);
  const conn = connection(env);
  let signature: string;
  try {
    signature = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  } catch (e) {
    const msg = (e as Error).message.slice(0, 300);
    await withdrawalsRepo.markFailed(sql, row.id, msg);
    if (/blockhash not found|expired/i.test(msg)) throw new HttpError(410, "quote_expired");
    throw new HttpError(
      422,
      /insufficient|0x1\b/i.test(msg) ? "insufficient_balance" : `send failed: ${msg}`,
    );
  }
  await withdrawalsRepo.markSubmitted(sql, row.id, signature, t);
  const [st] = (await conn.getSignatureStatuses([signature])).value;
  return {
    signature,
    requestId: row.id,
    status: st?.confirmationStatus ? ("confirmed" as const) : ("pending" as const),
  };
}

// Status by signature; settles our row when the chain has an answer.
export async function status(env: Env, sql: Sql, user: UserRow, requestId: string) {
  const [row] = await withdrawalsRepo.byId(sql, requestId, user.id);
  if (!row) throw notFound("withdrawal");
  if (row.status === "submitted" && row.signature) {
    const [st] = (
      await connection(env).getSignatureStatuses([row.signature], { searchTransactionHistory: true })
    ).value;
    if (st?.err) await withdrawalsRepo.markFailed(sql, row.id, JSON.stringify(st.err).slice(0, 300));
    else if (st && st.confirmationStatus !== "processed")
      await withdrawalsRepo.markConfirmed(sql, row.id, now());
    return {
      requestId,
      signature: row.signature,
      status: st?.err ? "failed" : st && st.confirmationStatus !== "processed" ? "confirmed" : "pending",
    };
  }
  return { requestId, signature: row.signature, status: row.status };
}
