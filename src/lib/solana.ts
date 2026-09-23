import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
  MessageV0,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { Env } from "../env";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const ATA_RENT_LAMPORTS = 2039280;
const REFERRAL_PROGRAM = new PublicKey("REFER4ZgmyYx9c6He5XfaTMiGfdLwRnkV4RPp9t9iF3");

// Where Jupiter pays our cut. The referral program cannot open one for a Token-2022 mint, so only USDC has one.
export const referralAta = (referral: string, mint: string) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("referral_ata"), new PublicKey(referral).toBuffer(), new PublicKey(mint).toBuffer()],
    REFERRAL_PROGRAM,
  )[0].toBase58();

export const connection = (env: Env) => new Connection(env.RPC_URL, "confirmed");

// Our gas payer. Secret is a base58 64-byte keypair (Phantom export) kept only in Worker secrets.
export const gasKeypair = (env: Env): Keypair => {
  if (!env.GAS_WALLET_SECRET) throw new Error("gas_wallet_not_configured");
  const raw = bs58.decode(env.GAS_WALLET_SECRET.trim());
  return raw.length === 64 ? Keypair.fromSecretKey(raw) : Keypair.fromSeed(raw.subarray(0, 32));
};

export const ata = (owner: PublicKey, mint: PublicKey, program = TOKEN_PROGRAM) =>
  PublicKey.findProgramAddressSync([owner.toBuffer(), program.toBuffer(), mint.toBuffer()], ATA_PROGRAM)[0];

// SPL Token / Token-2022 `TransferChecked` (ix 12): amount u64 LE + decimals u8.
export const transferChecked = (
  source: PublicKey,
  mint: PublicKey,
  dest: PublicKey,
  owner: PublicKey,
  amount: bigint,
  decimals: number,
  program: PublicKey,
) => {
  const data = new Uint8Array(10);
  data[0] = 12;
  new DataView(data.buffer).setBigUint64(1, amount, true);
  data[9] = decimals;
  return new TransactionInstruction({
    programId: program,
    data: Buffer.from(data),
    keys: [
      { pubkey: source, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: dest, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
  });
};

// ATA `CreateIdempotent` (ix 1), rent paid by `payer`.
export const createAtaIdempotent = (
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  program: PublicKey,
) =>
  new TransactionInstruction({
    programId: ATA_PROGRAM,
    data: Buffer.from([1]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata(owner, mint, program), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
  });

export type JupIx = {
  programId: string;
  accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
  data: string;
};
export const fromJup = (ix: JupIx) =>
  new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    data: Buffer.from(ix.data, "base64"),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
  });

// Token-2022 transfer fee (bps) baked into the mint, e.g. PreStocks charge 1% on every transfer. Cached 10 min.
const feeCache = new Map<string, { at: number; bps: number }>();
export async function transferFeeBps(conn: Connection, mint: PublicKey): Promise<number> {
  const k = mint.toBase58(),
    hit = feeCache.get(k);
  if (hit && Date.now() - hit.at < 600_000) return hit.bps;
  const info = await conn.getParsedAccountInfo(mint);
  const data = info.value?.data;
  const exts = data && "parsed" in data ? (data.parsed.info?.extensions ?? []) : [];
  const cfg = exts.find((e: { extension: string }) => e.extension === "transferFeeConfig")?.state;
  const bps = Number(cfg?.newerTransferFee?.transferFeeBasisPoints ?? 0);
  feeCache.set(k, { at: Date.now(), bps });
  return bps;
}

// Lookup tables are append-only and Jupiter's rarely change; cache per isolate for 10 minutes.
const altCache = new Map<string, { at: number; alt: AddressLookupTableAccount }>();
export async function lookupTables(
  conn: Connection,
  addresses: string[],
): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const t = Date.now();
  const missing = addresses.filter((a) => !(altCache.get(a) && t - altCache.get(a)!.at < 600_000));
  if (missing.length) {
    const infos = await conn.getMultipleAccountsInfo(missing.map((a) => new PublicKey(a)));
    infos.forEach((info, i) => {
      if (info)
        altCache.set(missing[i]!, {
          at: t,
          alt: new AddressLookupTableAccount({
            key: new PublicKey(missing[i]!),
            state: AddressLookupTableAccount.deserialize(info.data),
          }),
        });
    });
  }
  return addresses.flatMap((a) => (altCache.get(a) ? [altCache.get(a)!.alt] : []));
}

// A blockhash is valid ~60s; reuse one for 5s so back-to-back quotes skip the RPC call.
let bhCache: { at: number; blockhash: string; lastValidBlockHeight: number } | null = null;
async function recentBlockhash(conn: Connection) {
  if (bhCache && Date.now() - bhCache.at < 5_000) return bhCache;
  const r = await conn.getLatestBlockhash("confirmed");
  bhCache = { at: Date.now(), ...r };
  return bhCache;
}

export async function buildV0(
  conn: Connection,
  payer: PublicKey,
  ixs: TransactionInstruction[],
  alts: AddressLookupTableAccount[],
) {
  const { blockhash, lastValidBlockHeight } = await recentBlockhash(conn);
  const msg = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: ixs,
  }).compileToV0Message(alts);
  return { tx: new VersionedTransaction(msg), lastValidBlockHeight };
}

export const u8 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) as Uint8Array<ArrayBuffer>;
export const sha256hex = async (b: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8(b))))
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

// Jupiter builds every order transaction with the maker as fee payer, and our makers hold no SOL. The gas
// wallet takes slot 0 instead — it is already a writable signer on a create (we pass it as `payer`), so those
// two slots swap; a cancel never names it, so it goes in front and every account index shifts by one. Any
// associated-token-account it opens on the way is billed to the same wallet.
export function gasPays(tx: VersionedTransaction, gas: PublicKey): VersionedTransaction {
  const m = tx.message as MessageV0;
  const g = m.staticAccountKeys.findIndex((k) => k.equals(gas));
  const keys = g < 0 ? [gas, ...m.staticAccountKeys] : [...m.staticAccountKeys];
  if (g > 0) [keys[0], keys[g]] = [keys[g]!, keys[0]!];
  const move = g < 0 ? (i: number) => i + 1 : (i: number) => (i === 0 ? g : i === g ? 0 : i);
  return new VersionedTransaction(
    new MessageV0({
      header: g < 0 ? { ...m.header, numRequiredSignatures: m.header.numRequiredSignatures + 1 } : m.header,
      staticAccountKeys: keys,
      recentBlockhash: m.recentBlockhash,
      compiledInstructions: m.compiledInstructions.map((ix) => {
        const accountKeyIndexes = ix.accountKeyIndexes.map(move);
        if (keys[move(ix.programIdIndex)]!.equals(ATA_PROGRAM)) accountKeyIndexes[0] = 0;
        return { ...ix, programIdIndex: move(ix.programIdIndex), accountKeyIndexes };
      }),
      addressTableLookups: m.addressTableLookups,
    }),
  );
}
