import type { Sql } from "../lib/db";
import type { PrivyUser } from "../lib/privy";
import { HttpError, badRequest, notFound } from "../lib/errors";
import { pgArr } from "./collections";
import { accountRepo, type UserRow, type WalletRow, type SettingsRow } from "../repos/account";
export type { UserRow, WalletRow, SettingsRow } from "../repos/account";

const now = () => Math.floor(Date.now() / 1000);
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/L
export const newCode = (n = 6) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
const sha = async (s: string) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s.toLowerCase())))).map((b) => b.toString(16).padStart(2, "0")).join("");

export const shapeSettings = (s: SettingsRow) => ({
  slippageBps: s.slippage_bps, quickBuyUsd: pgArr(s.quick_buy_usd).map(Number), quickSellPct: pgArr(s.quick_sell_pct).map(Number),
  priority: s.priority as "normal" | "fast" | "turbo", confirmBeforeTrade: s.confirm_before_trade, hideDust: s.hide_dust,
});
export const shapeWallet = (w: WalletRow) => ({ address: w.address, chain: w.chain as "solana" | "evm", hdIndex: w.hd_index, label: w.label, isDefault: w.is_default, createdAt: Number(w.created_at) });

// First sight of a Privy user: create the user, settings and their wallets (as reported by the token). Every later
// call just stamps last_seen and syncs any wallet Privy added since (multi-account).
export async function ensureUser(sql: Sql, p: PrivyUser, invitesPerUser: number): Promise<{ user: UserRow; wallets: WalletRow[]; settings: SettingsRow }> {
  const t = now();
  const emailHash = p.email ? await sha(p.email) : null;
  let user = (await accountRepo.touch(sql, p.id, t, emailHash))[0];
  if (!user) {
    for (let i = 0; i < 5 && !user; i++) {
      const code = newCode();
      try {
        user = (await accountRepo.create(sql, p.id, emailHash, code, t))[0];
        await accountRepo.createPersonalCode(sql, code, p.id, invitesPerUser, t);
      } catch (e) { if (!/duplicate key/.test((e as Error).message)) throw e; }
    }
    if (!user) throw new Error("could not allocate referral code");
    await accountRepo.createSettings(sql, p.id, t);
  }
  const existing = await accountRepo.wallets(sql, user.id);
  const known = new Set(existing.map((w) => w.address));
  let idx = existing.length;
  for (const w of p.wallets) {
    if (known.has(w.address)) continue;
    await accountRepo.addWallet(sql, { address: w.address, userId: user.id, chain: w.chain, idx, label: idx === 0 ? "Main" : `Account ${idx + 1}`, isDefault: idx === 0, t });
    idx++;
  }
  const wallets = idx === existing.length ? existing : await accountRepo.wallets(sql, user.id);
  const settings = (await accountRepo.settings(sql, user.id))[0];
  if (!settings) throw new Error("settings row missing");
  return { user, wallets, settings };
}

export async function updateProfile(sql: Sql, id: string, handle: string | undefined, avatar: string | null | undefined): Promise<UserRow> {
  try {
    const u = (await accountRepo.updateProfile(sql, id, handle ?? null, avatar))[0];
    if (!u) throw notFound("user");
    return u;
  } catch (e) {
    if (/duplicate key/.test((e as Error).message)) throw new HttpError(409, "handle taken");
    throw e;
  }
}

export async function redeemInvite(sql: Sql, userId: string, code: string) {
  const t = now();
  const u = (await accountRepo.byId(sql, userId))[0];
  if (!u) throw notFound("user");
  if (u.activated_at) throw new HttpError(409, "already activated");
  const c = (await accountRepo.invite(sql, code.toUpperCase()))[0];
  if (!c) throw notFound("invite code");
  if (c.uses >= c.max_uses || (c.expires_at && c.expires_at < t)) throw new HttpError(410, "invite code used up or expired");
  if (c.owner_user_id === userId) throw badRequest("you cannot use your own code");
  const ok = await accountRepo.redeem(sql, c.code, c.owner_user_id, userId, t);
  if (!ok) throw new HttpError(410, "invite code used up or expired");
}

export async function referrals(sql: Sql, user: UserRow) {
  const [code, referred, [earn]] = await Promise.all([accountRepo.invite(sql, user.referral_code).then((r) => r[0]), accountRepo.referred(sql, user.id), accountRepo.earnings(sql, user.id)]);
  return {
    code: user.referral_code, link: `https://apeme.fun/i/${user.referral_code}`,
    invitesLeft: code ? Math.max(0, code.max_uses - code.uses) : 0,
    referred: referred.map((r) => ({ userId: r.id, handle: r.handle, joinedAt: Number(r.joined_at), volumeUsd: r.volume_usd == null ? 0 : Number(r.volume_usd) })),
    earnedUsd: Number(earn?.earned ?? 0), claimableUsd: Number(earn?.claimable ?? 0),
  };
}

export async function updateSettings(sql: Sql, userId: string, cur: SettingsRow, b: { slippageBps?: number; quickBuyUsd?: number[]; quickSellPct?: number[]; priority?: string; confirmBeforeTrade?: boolean; hideDust?: boolean }): Promise<SettingsRow> {
  const row = (await accountRepo.updateSettings(sql, userId, {
    slippageBps: b.slippageBps ?? cur.slippage_bps, buyCsv: (b.quickBuyUsd ?? pgArr(cur.quick_buy_usd).map(Number)).join(","), sellCsv: (b.quickSellPct ?? pgArr(cur.quick_sell_pct).map(Number)).join(","),
    priority: b.priority ?? cur.priority, confirm: b.confirmBeforeTrade ?? cur.confirm_before_trade, hideDust: b.hideDust ?? cur.hide_dust,
  }))[0];
  if (!row) throw notFound("settings");
  return row;
}

export async function mintAdminCodes(sql: Sql, count: number, maxUses: number, label: string | null, expiresAt: number | null): Promise<string[]> {
  const t = now(); const codes: string[] = [];
  while (codes.length < count) {
    const code = newCode(8);
    const r = await accountRepo.createAdminCode(sql, code, maxUses, label, expiresAt, t);
    if (r.length) codes.push(code);
  }
  return codes;
}
