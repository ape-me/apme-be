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
const SYSTEM_PROGRAM = new PublicKey("11111111111111111111111111111111");
const ULTRA_PROJECT = new PublicKey("DkiqsTrw1u1bYFumumC7sCG2S8K25qc2vemJFHyW2wJc"); // Jupiter Ultra referral project
const REFERRAL_NAME = "stonks247";
const DISC_INIT_REFERRAL = Buffer.from([241, 190, 107, 26, 244, 236, 119, 229]);
const DISC_INIT_REFERRAL_TOKEN = Buffer.from([125, 18, 70, 95, 86, 179, 221, 190]);

// Our Swap v2 referral account: a PDA of the project and name, so its address is fixed before it exists.
export const ultraReferralAccount = () =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("referral"), ULTRA_PROJECT.toBuffer(), Buffer.from(REFERRAL_NAME)],
    REFERRAL_PROGRAM,
  )[0];

// Referral program `initialize_referral_account_with_name`: fees accrue to `partner`, who needs no signature.
export const initReferralAccount = (payer: PublicKey, partner: PublicKey) => {
  const name = Buffer.from(REFERRAL_NAME);
  const len = Buffer.alloc(4);
  len.writeUInt32LE(name.length);
  return new TransactionInstruction({
    programId: REFERRAL_PROGRAM,
    data: Buffer.concat([DISC_INIT_REFERRAL, len, name]),
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: partner, isSigner: false, isWritable: false },
      { pubkey: ULTRA_PROJECT, isSigner: false, isWritable: false },
      { pubkey: ultraReferralAccount(), isSigner: false, isWritable: true },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
    ],
  });
};

// Referral program `initialize_referral_token_account`: the vault Jupiter pays our cut into, one per mint.
export const initReferralTokenAccount = (payer: PublicKey, mint: PublicKey) =>
  new TransactionInstruction({
    programId: REFERRAL_PROGRAM,
    data: DISC_INIT_REFERRAL_TOKEN,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ULTRA_PROJECT, isSigner: false, isWritable: false },
      { pubkey: ultraReferralAccount(), isSigner: false, isWritable: false },
      {
        pubkey: new PublicKey(referralAta(ultraReferralAccount().toBase58(), mint.toBase58())),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM, isSigner: false, isWritable: false },
    ],
  });

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
      { pubkey: SYSTEM_PROGRAM, isSigner: false, isWritable: false },
      { pubkey: program, isSigner: false, isWritable: false },
    ],
  });

// What a transfer needs to know about a mint: owning program, decimals, Token-2022 transfer fee (PreStocks
// charge 1% on every transfer) and whether a transfer hook is armed. Mints never change owner; cached 10 min.
export type MintInfo = { program: PublicKey; decimals: number; feeBps: number; hooked: boolean };
const mintCache = new Map<string, { at: number; info: MintInfo }>();
export async function mintInfo(conn: Connection, mint: PublicKey): Promise<MintInfo> {
  const k = mint.toBase58(),
    hit = mintCache.get(k);
  if (hit && Date.now() - hit.at < 600_000) return hit.info;
  const acc = (await conn.getParsedAccountInfo(mint)).value;
  const data = acc?.data;
  if (!acc || !data || !("parsed" in data) || data.parsed.type !== "mint") throw new Error("not_a_mint");
  const exts: { extension: string; state?: Record<string, unknown> }[] = data.parsed.info?.extensions ?? [];
  const fee = exts.find((e) => e.extension === "transferFeeConfig")?.state as
    { newerTransferFee?: { transferFeeBasisPoints?: number } } | undefined;
  const info: MintInfo = {
    program: acc.owner,
    decimals: Number(data.parsed.info.decimals),
    feeBps: Number(fee?.newerTransferFee?.transferFeeBasisPoints ?? 0),
    hooked: exts.some((e) => e.extension === "transferHook" && e.state?.programId != null),
  };
  mintCache.set(k, { at: Date.now(), info });
  return info;
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
