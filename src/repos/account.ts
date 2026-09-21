import type { Sql } from "../lib/db";

export type UserRow = {
  id: string;
  handle: string | null;
  avatar_url: string | null;
  referral_code: string;
  invited_by: string | null;
  activated_at: number | null;
  created_at: number;
};
export type WalletRow = {
  address: string;
  user_id: string;
  chain: string;
  hd_index: number;
  label: string;
  is_default: boolean;
  created_at: number;
};
export type SettingsRow = {
  slippage_bps: number;
  quick_buy_usd: number[] | string;
  quick_sell_pct: number[] | string;
  priority: string;
  confirm_before_trade: boolean;
  hide_dust: boolean;
};
type InviteRow = {
  code: string;
  kind: string;
  owner_user_id: string | null;
  max_uses: number;
  uses: number;
  label: string | null;
  expires_at: number | null;
  created_at: number;
};

export const accountRepo = {
  touch: (sql: Sql, id: string, t: number, emailHash: string | null) =>
    sql<
      UserRow[]
    >`UPDATE users SET last_seen_at = ${t}, email_hash = COALESCE(${emailHash}, email_hash) WHERE id = ${id} RETURNING *`,
  create: (sql: Sql, id: string, emailHash: string | null, code: string, t: number) =>
    sql<
      UserRow[]
    >`INSERT INTO users (id, email_hash, referral_code, created_at, last_seen_at) VALUES (${id}, ${emailHash}, ${code}, ${t}, ${t}) RETURNING *`,
  createPersonalCode: (sql: Sql, code: string, owner: string, maxUses: number, t: number) =>
    sql`INSERT INTO invite_codes (code, kind, owner_user_id, max_uses, created_at) VALUES (${code}, 'user', ${owner}, ${maxUses}, ${t}) ON CONFLICT DO NOTHING`,
  createSettings: (sql: Sql, id: string, t: number) =>
    sql`INSERT INTO user_settings (user_id, updated_at) VALUES (${id}, ${t}) ON CONFLICT DO NOTHING`,
  byId: (sql: Sql, id: string) => sql<UserRow[]>`SELECT * FROM users WHERE id = ${id}`,
  updateProfile: (sql: Sql, id: string, handle: string | null, avatar: string | null | undefined) =>
    sql<
      UserRow[]
    >`UPDATE users SET handle = COALESCE(${handle}, handle), avatar_url = ${avatar === undefined ? sql`avatar_url` : avatar} WHERE id = ${id} RETURNING *`,

  wallets: (sql: Sql, userId: string) =>
    sql<WalletRow[]>`SELECT * FROM wallets WHERE user_id = ${userId} ORDER BY hd_index`,
  addWallet: (
    sql: Sql,
    w: {
      address: string;
      userId: string;
      chain: string;
      idx: number;
      label: string;
      isDefault: boolean;
      t: number;
    },
  ) =>
    sql`INSERT INTO wallets (address, user_id, chain, hd_index, label, is_default, created_at)
        VALUES (${w.address}, ${w.userId}, ${w.chain}, ${w.idx}, ${w.label}, ${w.isDefault}, ${w.t}) ON CONFLICT (address) DO NOTHING`,
  setDefaultWallet: (sql: Sql, userId: string, address: string) =>
    sql`UPDATE wallets SET is_default = (address = ${address}) WHERE user_id = ${userId}`,
  labelWallet: (sql: Sql, address: string, label: string) =>
    sql`UPDATE wallets SET label = ${label} WHERE address = ${address}`,

  settings: (sql: Sql, userId: string) =>
    sql<SettingsRow[]>`SELECT * FROM user_settings WHERE user_id = ${userId}`,
  updateSettings: (
    sql: Sql,
    userId: string,
    s: {
      slippageBps: number;
      buyCsv: string;
      sellCsv: string;
      priority: string;
      confirm: boolean;
      hideDust: boolean;
    },
  ) =>
    sql<
      SettingsRow[]
    >`UPDATE user_settings SET slippage_bps = ${s.slippageBps}, quick_buy_usd = string_to_array(${s.buyCsv}, ',')::int[],
      quick_sell_pct = string_to_array(${s.sellCsv}, ',')::int[], priority = ${s.priority}, confirm_before_trade = ${s.confirm}, hide_dust = ${s.hideDust},
      updated_at = ${Math.floor(Date.now() / 1000)} WHERE user_id = ${userId} RETURNING *`,

  invite: (sql: Sql, code: string) => sql<InviteRow[]>`SELECT * FROM invite_codes WHERE code = ${code}`,
  // One transaction: consume a use, activate the user, record who referred whom.
  redeem: (sql: Sql, code: string, ownerId: string | null, userId: string, t: number) =>
    sql.begin(async (tx) => {
      const bumped =
        await tx`UPDATE invite_codes SET uses = uses + 1 WHERE code = ${code} AND uses < max_uses RETURNING code`;
      if (!bumped.length) return false;
      await tx`UPDATE users SET activated_at = ${t}, invited_by = ${ownerId} WHERE id = ${userId}`;
      if (ownerId)
        await tx`INSERT INTO referrals (referee_user_id, referrer_user_id, code, created_at) VALUES (${userId}, ${ownerId}, ${code}, ${t}) ON CONFLICT DO NOTHING`;
      return true;
    }),
  listInvites: (
    sql: Sql,
  ) => sql`SELECT i.code, i.kind, i.label, i.max_uses, i.uses, i.expires_at, i.created_at, u.handle AS owner
                                 FROM invite_codes i LEFT JOIN users u ON u.id = i.owner_user_id ORDER BY i.created_at DESC LIMIT 500`,
  createAdminCode: (
    sql: Sql,
    code: string,
    maxUses: number,
    label: string | null,
    expiresAt: number | null,
    t: number,
  ) =>
    sql`INSERT INTO invite_codes (code, kind, max_uses, label, expires_at, created_at) VALUES (${code}, 'admin', ${maxUses}, ${label}, ${expiresAt}, ${t}) ON CONFLICT DO NOTHING RETURNING code`,

  referred: (sql: Sql, referrerId: string) => sql<
    { id: string; handle: string | null; joined_at: number; volume_usd: number | null }[]
  >`
    SELECT u.id, u.handle, r.created_at AS joined_at, (SELECT SUM(in_usd) FROM swaps s WHERE s.user_id = u.id AND s.status = 'confirmed') AS volume_usd
    FROM referrals r JOIN users u ON u.id = r.referee_user_id WHERE r.referrer_user_id = ${referrerId} ORDER BY r.created_at DESC`,
  earnings: (sql: Sql, referrerId: string) => sql<{ earned: number | null; claimable: number | null }[]>`
    SELECT SUM(amount_usd) AS earned, SUM(amount_usd) FILTER (WHERE status = 'accrued') AS claimable FROM referral_earnings WHERE referrer_user_id = ${referrerId}`,

  accrued: (sql: Sql, referrerId: string) =>
    sql<
      { id: string; amount_usd: number }[]
    >`SELECT id, amount_usd FROM referral_earnings WHERE referrer_user_id = ${referrerId} AND status = 'accrued'`,
  markPaid: (sql: Sql, ids: string[], sig: string, t: number) =>
    sql`UPDATE referral_earnings SET status = 'paid', paid_signature = ${sig}, paid_at = ${t} WHERE id IN ${sql(ids)} AND status = 'accrued'`,
  payouts: (sql: Sql, referrerId: string) => sql<
    { paid_signature: string; amount: number; paid_at: number }[]
  >`
    SELECT paid_signature, SUM(amount_usd) AS amount, MAX(paid_at) AS paid_at FROM referral_earnings WHERE referrer_user_id = ${referrerId} AND status = 'paid' GROUP BY paid_signature ORDER BY MAX(paid_at) DESC LIMIT 20`,
  watchlist: (sql: Sql, userId: string) =>
    sql<{ mint: string }[]>`SELECT mint FROM watchlist WHERE user_id = ${userId} ORDER BY added_at DESC`,
  star: (sql: Sql, userId: string, mint: string, t: number) =>
    sql`INSERT INTO watchlist (user_id, mint, added_at) VALUES (${userId}, ${mint}, ${t}) ON CONFLICT DO NOTHING`,
  unstar: (sql: Sql, userId: string, mint: string) =>
    sql`DELETE FROM watchlist WHERE user_id = ${userId} AND mint = ${mint}`,
};
