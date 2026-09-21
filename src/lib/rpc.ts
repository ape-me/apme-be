import type { Env } from "../env";

const TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
export const SOL_MINT = "So11111111111111111111111111111111111111112";

const call = async (env: Env, method: string, params: unknown[]) => {
  const r = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (j.error) throw new Error(`rpc ${method}: ${j.error.message}`);
  return j.result;
};

type Balance = { mint: string; amount: number; raw: string; decimals: number };

// SOL plus every SPL / Token-2022 balance a wallet holds. Empty accounts are dropped.
export async function balances(env: Env, owner: string): Promise<{ sol: number; tokens: Balance[] }> {
  const parsed = (program: string) =>
    call(env, "getTokenAccountsByOwner", [
      owner,
      { programId: program },
      { encoding: "jsonParsed" },
    ]) as Promise<{
      value: {
        account: {
          data: {
            parsed: {
              info: {
                mint: string;
                tokenAmount: { amount: string; decimals: number; uiAmount: number | null };
              };
            };
          };
        };
      }[];
    }>;
  const [lamports, a, b] = await Promise.all([
    call(env, "getBalance", [owner]) as Promise<{ value: number }>,
    parsed(TOKEN),
    parsed(TOKEN_2022),
  ]);
  const tokens = [...a.value, ...b.value]
    .map((x) => x.account.data.parsed.info)
    .filter((i) => i.tokenAmount.amount !== "0")
    .map((i) => ({
      mint: i.mint,
      amount: i.tokenAmount.uiAmount ?? Number(i.tokenAmount.amount) / 10 ** i.tokenAmount.decimals,
      raw: i.tokenAmount.amount,
      decimals: i.tokenAmount.decimals,
    }));
  return { sol: lamports.value / 1e9, tokens };
}

// SOL in USD from Jupiter, cached at the edge for 30s.
export async function solPrice(): Promise<number | null> {
  const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`, {
    cf: { cacheTtl: 30, cacheEverything: true },
  } as RequestInit);
  if (!r.ok) return null;
  const j = (await r.json()) as Record<string, { usdPrice?: number }>;
  return j[SOL_MINT]?.usdPrice ?? null;
}

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

type Deposit = {
  sig: string;
  ts: number;
  amount: number;
  from: string | null;
  mint: string;
  direction: "in" | "out";
};

// Last few USDC transfers on the wallet's USDC account: one signatures call + one batched getTransaction.
export async function usdcTransfers(env: Env, usdcAta: string, limit = 8): Promise<Deposit[]> {
  const sigs = (await call(env, "getSignaturesForAddress", [usdcAta, { limit }])) as {
    signature: string;
    blockTime: number | null;
    err: unknown;
  }[];
  const ok = sigs.filter((s) => !s.err);
  if (!ok.length) return [];
  const body = ok.map((s, i) => ({
    jsonrpc: "2.0",
    id: i,
    method: "getTransaction",
    params: [
      s.signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ],
  }));
  const r = await fetch(env.RPC_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const txs = (await r.json()) as {
    id: number;
    result: {
      blockTime: number;
      transaction: { message: { instructions: unknown[] } };
      meta: { innerInstructions?: { instructions: unknown[] }[] };
    } | null;
  }[];
  const out: Deposit[] = [];
  for (const t of txs) {
    if (!t.result) continue;
    const sig = ok[t.id]!.signature;
    const ixs = [
      ...t.result.transaction.message.instructions,
      ...(t.result.meta.innerInstructions ?? []).flatMap((x) => x.instructions),
    ] as { program?: string; parsed?: { type: string; info: Record<string, string> } }[];
    let net = 0;
    let from: string | null = null;
    for (const ix of ixs) {
      if (ix.program !== "spl-token" || !ix.parsed || !/^transfer(Checked)?$/.test(ix.parsed.type)) continue;
      const info = ix.parsed.info;
      const amt =
        Number(info.tokenAmount ? (info.tokenAmount as unknown as { amount: string }).amount : info.amount) /
        1e6;
      if (info.destination === usdcAta) {
        net += amt;
        from = info.authority ?? info.source ?? from;
      } else if (info.source === usdcAta) net -= amt;
    }
    if (Math.abs(net) < 0.000001) continue;
    out.push({
      sig,
      ts: t.result.blockTime,
      amount: Math.abs(net),
      from: net > 0 ? from : null,
      mint: USDC_MINT,
      direction: net > 0 ? "in" : "out",
    });
  }
  return out;
}
