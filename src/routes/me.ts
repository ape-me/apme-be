import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { Env } from "../env";
import { withDb, type DbVars } from "../lib/db";
import { HttpError, badRequest, notFound, unauthorized } from "../lib/errors";
import { verifyIdToken, type PrivyUser } from "../lib/privy";
import { Mint } from "../contract";
import { ensureUser, redeemInvite, referrals, updateProfile, updateSettings, shapeSettings, shapeWallet, type UserRow, type WalletRow, type SettingsRow } from "../services/account";
import { accountRepo } from "../repos/account";
import { catalog } from "../services/catalog";

export type AuthVars = DbVars & { privy: PrivyUser; user: UserRow; wallets: WalletRow[]; settings: SettingsRow };

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const r = schema.safeParse(v);
  if (!r.success) throw badRequest(r.error.issues.map((i) => `${i.path.join(".") || "value"}: ${i.message}`).join("; "));
  return r.data;
};

// Every /v1/me and trade route: verify the Privy identity token, load (or create) the user.
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  if (!c.env.PRIVY_APP_ID) throw new HttpError(503, "auth_not_configured");
  const token = c.req.header("privy-id-token") ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw unauthorized();
  const privy = await verifyIdToken(c.env, token);
  const { user, wallets, settings } = await ensureUser(c.get("sql"), privy, Number(c.env.INVITES_PER_USER ?? 5));
  c.set("privy", privy); c.set("user", user); c.set("wallets", wallets); c.set("settings", settings);
  await next();
};

// Trading and other gated actions need a redeemed invite while the gate is on.
export const requireActive: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  if (c.env.INVITE_GATE !== "0" && !c.get("user").activated_at) throw new HttpError(403, "invite_required");
  await next();
};

const shapeMe = (c: { env: Env }, user: UserRow, wallets: WalletRow[], settings: SettingsRow, referral: { code: string; invitesLeft: number; earnedUsd: number }) => ({
  userId: user.id, handle: user.handle, avatarUrl: user.avatar_url,
  status: c.env.INVITE_GATE !== "0" && !user.activated_at ? "invite_required" : "active",
  wallets: wallets.map(shapeWallet), settings: shapeSettings(settings),
  referral, createdAt: Number(user.created_at),
});

export const me = new Hono<{ Bindings: Env; Variables: AuthVars }>();
me.use("*", withDb, requireAuth);

me.get("/", async (c) => {
  const r = await referrals(c.get("sql"), c.get("user"));
  return c.json(shapeMe(c, c.get("user"), c.get("wallets"), c.get("settings"), { code: r.code, invitesLeft: r.invitesLeft, earnedUsd: r.earnedUsd }));
});

const Handle = z.string().regex(/^[a-z0-9_]{3,20}$/, "3-20 chars, a-z 0-9 _");
me.patch("/", async (c) => {
  const b = parse(z.object({ handle: Handle.optional(), avatarUrl: z.string().url().max(500).nullable().optional() }), await c.req.json());
  const u = await updateProfile(c.get("sql"), c.get("user").id, b.handle, b.avatarUrl);
  const r = await referrals(c.get("sql"), u);
  return c.json(shapeMe(c, u, c.get("wallets"), c.get("settings"), { code: r.code, invitesLeft: r.invitesLeft, earnedUsd: r.earnedUsd }));
});

me.post("/invite", async (c) => {
  const b = parse(z.object({ code: z.string().min(4).max(16) }), await c.req.json());
  await redeemInvite(c.get("sql"), c.get("user").id, b.code);
  return c.json({ ok: true, status: "active" });
});

me.get("/referrals", async (c) => c.json(await referrals(c.get("sql"), c.get("user"))));

me.get("/settings", (c) => c.json(shapeSettings(c.get("settings"))));
const Settings = z.object({
  slippageBps: z.number().int().min(10).max(500).optional(),
  quickBuyUsd: z.array(z.number().int().min(1).max(100000)).min(1).max(4).optional(),
  quickSellPct: z.array(z.number().int().min(1).max(100)).min(1).max(4).optional(),
  priority: z.enum(["normal", "fast", "turbo"]).optional(),
  confirmBeforeTrade: z.boolean().optional(),
  hideDust: z.boolean().optional(),
});
me.patch("/settings", async (c) => {
  const b = parse(Settings, await c.req.json());
  return c.json(shapeSettings(await updateSettings(c.get("sql"), c.get("user").id, c.get("settings"), b)));
});

me.get("/wallets", (c) => c.json({ wallets: c.get("wallets").map(shapeWallet) }));
me.patch("/wallets/:address", async (c) => {
  const address = c.req.param("address");
  const w = c.get("wallets").find((x) => x.address === address);
  if (!w) throw notFound("wallet");
  const b = parse(z.object({ label: z.string().min(1).max(24).optional(), isDefault: z.literal(true).optional() }), await c.req.json());
  const sql = c.get("sql");
  if (b.isDefault) await accountRepo.setDefaultWallet(sql, w.user_id, address);
  if (b.label) await accountRepo.labelWallet(sql, address, b.label);
  return c.json({ wallets: (await accountRepo.wallets(sql, w.user_id)).map(shapeWallet) });
});

// Watchlist: stars are per user, returned as full Stock objects so the FE needs no second call.
me.get("/watchlist", async (c) => {
  const sql = c.get("sql");
  const rows = await accountRepo.watchlist(sql, c.get("user").id);
  if (!rows.length) return c.json({ stocks: [] });
  return c.json(await catalog.stocksByMints(sql, rows.map((r) => r.mint)));
});
me.put("/watchlist/:mint", async (c) => {
  const mint = parse(Mint, c.req.param("mint"));
  await accountRepo.star(c.get("sql"), c.get("user").id, mint, Math.floor(Date.now() / 1000));
  return c.json({ ok: true });
});
me.delete("/watchlist/:mint", async (c) => {
  const mint = parse(Mint, c.req.param("mint"));
  await accountRepo.unstar(c.get("sql"), c.get("user").id, mint);
  return c.json({ ok: true });
});
