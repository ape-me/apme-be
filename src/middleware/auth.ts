import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import type { DbVars } from "./db";
import { HttpError, unauthorized } from "../lib/errors";
import { verifyIdToken, fetchUserAccounts, type PrivyUser } from "../lib/privy";
import { ensureUser, type UserRow, type WalletRow, type SettingsRow } from "../services/account";

export type AuthVars = DbVars & { privy: PrivyUser; user: UserRow; wallets: WalletRow[]; settings: SettingsRow };

// Every /v1/me and trade route: verify the Privy identity token, load (or create) the user.
export const requireAuth: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  if (!c.env.PRIVY_APP_ID) throw new HttpError(503, "auth_not_configured");
  // Identity token preferred (carries the wallets); Privy access token accepted as a fallback (same signer, no wallets).
  const token = c.req.header("privy-id-token")?.trim() || c.req.header("authorization")?.replace(/^Bearer\s+/i, "").trim();
  if (!token) throw unauthorized();
  const privy = await verifyIdToken(c.env, token);
  if (!privy.wallets.length) { const acc = await fetchUserAccounts(c.env, privy.id); if (acc) { privy.wallets = acc.wallets; privy.email ??= acc.email; } }
  const { user, wallets, settings } = await ensureUser(c.get("sql"), privy, Number(c.env.INVITES_PER_USER ?? 5));
  c.set("privy", privy); c.set("user", user); c.set("wallets", wallets); c.set("settings", settings);
  await next();
};

// Trading and other gated actions need a redeemed invite while the gate is on.
export const requireActive: MiddlewareHandler<{ Bindings: Env; Variables: AuthVars }> = async (c, next) => {
  if (c.env.INVITE_GATE !== "0" && !c.get("user").activated_at) throw new HttpError(403, "invite_required");
  await next();
};

export const requireAdmin: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const t = c.req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!c.env.ADMIN_TOKEN || t !== c.env.ADMIN_TOKEN) throw unauthorized();
  await next();
};
