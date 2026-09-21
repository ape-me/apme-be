import { Connection, Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction, AddressLookupTableAccount } from "@solana/web3.js";
import bs58 from "bs58";
import type { Env } from "../env";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const SOL_MINT = "So11111111111111111111111111111111111111112";
export const TOKEN_PROGRAM = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const ATA_PROGRAM = new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
export const ATA_RENT_LAMPORTS = 2039280;

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
export const transferChecked = (source: PublicKey, mint: PublicKey, dest: PublicKey, owner: PublicKey, amount: bigint, decimals: number, program: PublicKey) => {
  const data = new Uint8Array(10); data[0] = 12; new DataView(data.buffer).setBigUint64(1, amount, true); data[9] = decimals;
  return new TransactionInstruction({ programId: program, data: Buffer.from(data), keys: [
    { pubkey: source, isSigner: false, isWritable: true }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: dest, isSigner: false, isWritable: true }, { pubkey: owner, isSigner: true, isWritable: false },
  ] });
};

// ATA `CreateIdempotent` (ix 1), rent paid by `payer`.
export const createAtaIdempotent = (payer: PublicKey, owner: PublicKey, mint: PublicKey, program: PublicKey) =>
  new TransactionInstruction({ programId: ATA_PROGRAM, data: Buffer.from([1]), keys: [
    { pubkey: payer, isSigner: true, isWritable: true }, { pubkey: ata(owner, mint, program), isSigner: false, isWritable: true },
    { pubkey: owner, isSigner: false, isWritable: false }, { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: new PublicKey("11111111111111111111111111111111"), isSigner: false, isWritable: false }, { pubkey: program, isSigner: false, isWritable: false },
  ] });

export type JupIx = { programId: string; accounts: { pubkey: string; isSigner: boolean; isWritable: boolean }[]; data: string };
export const fromJup = (ix: JupIx) => new TransactionInstruction({
  programId: new PublicKey(ix.programId), data: Buffer.from(ix.data, "base64"),
  keys: ix.accounts.map((a) => ({ pubkey: new PublicKey(a.pubkey), isSigner: a.isSigner, isWritable: a.isWritable })),
});

export async function lookupTables(conn: Connection, addresses: string[]): Promise<AddressLookupTableAccount[]> {
  if (!addresses.length) return [];
  const infos = await conn.getMultipleAccountsInfo(addresses.map((a) => new PublicKey(a)));
  return infos.flatMap((info, i) => info ? [new AddressLookupTableAccount({ key: new PublicKey(addresses[i]!), state: AddressLookupTableAccount.deserialize(info.data) })] : []);
}

export async function buildV0(conn: Connection, payer: PublicKey, ixs: TransactionInstruction[], alts: AddressLookupTableAccount[]) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message(alts);
  return { tx: new VersionedTransaction(msg), lastValidBlockHeight };
}

export const u8 = (b: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(b) as Uint8Array<ArrayBuffer>;
export const sha256hex = async (b: Uint8Array) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", u8(b)))).map((x) => x.toString(16).padStart(2, "0")).join("");
