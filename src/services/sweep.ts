import { PublicKey, SystemProgram, type TransactionInstruction } from "@solana/web3.js";
import type { Env } from "../env";
import type { Sql } from "../lib/db";
import { USDC_MINT, connection, gasKeypair, closeAccount } from "../lib/solana";
import { tokenAccounts } from "../lib/rpc";
import { sweepRepo } from "../repos/sweep";

const MAX_CLOSES = 5;
const now = () => Math.floor(Date.now() / 1000);

// No user wallet ever keeps SOL. Whatever Jupiter handed it (order rent on close) comes back to the gas wallet
// on the next transaction the wallet signs with us, and its empty token accounts close to the gas wallet too.
// `incoming` is SOL that lands inside this same transaction, so it can leave in it as well.
export async function sweep(env: Env, sql: Sql, wallet: PublicKey, incoming = 0n) {
  const gas = gasKeypair(env).publicKey;
  const address = wallet.toBase58();
  const [owed, held, accounts] = await Promise.all([
    sweepRepo.owed(sql, address),
    connection(env).getBalance(wallet, "confirmed"),
    tokenAccounts(env, address),
  ]);
  const lamports = [owed + incoming, BigInt(held) + incoming].reduce((a, b) => (a < b ? a : b));
  const ixs: TransactionInstruction[] = [];
  if (lamports > 0n) ixs.push(SystemProgram.transfer({ fromPubkey: wallet, toPubkey: gas, lamports }));
  const empty = accounts.filter((a) => a.amount === "0" && a.withheld === "0" && a.mint !== USDC_MINT);
  for (const a of empty.slice(0, MAX_CLOSES))
    ixs.push(closeAccount(new PublicKey(a.pubkey), gas, wallet, new PublicKey(a.program)));
  return { ixs, lamports };
}

// The transaction carrying the sweep went out: what it moved is no longer owed.
export const swept = (sql: Sql, wallet: string, lamports: bigint) =>
  lamports > 0n ? sweepRepo.take(sql, wallet, lamports, now()) : Promise.resolve();

// Jupiter closed an order and handed its rent to the maker: owed until the next sweep.
export const owe = (sql: Sql, wallet: string, lamports: bigint) =>
  lamports > 0n ? sweepRepo.add(sql, wallet, lamports, now()) : Promise.resolve();

// Everything an order would hand back on close: the order account plus any token account it owns.
export async function orderRent(env: Env, order: string): Promise<bigint> {
  const conn = connection(env);
  const key = new PublicKey(order);
  const [acc, a, b] = await Promise.all([
    conn.getAccountInfo(key),
    conn.getTokenAccountsByOwner(key, {
      programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
    }),
    conn.getTokenAccountsByOwner(key, {
      programId: new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"),
    }),
  ]);
  return BigInt((acc?.lamports ?? 0) + [...a.value, ...b.value].reduce((n, x) => n + x.account.lamports, 0));
}
