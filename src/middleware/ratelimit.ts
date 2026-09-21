import type { MiddlewareHandler } from "hono";
import type { Env } from "../env";
import { HttpError } from "../lib/errors";

// Per-IP limit via the Workers rate-limit binding. Absent binding (local dev) means no limit.
export const rateLimited: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const rl = c.env.RL_READ;
  if (rl) {
    const key = c.req.header("cf-connecting-ip") ?? "anon";
    const { success } = await rl.limit({ key });
    if (!success) throw new HttpError(429, "slow down");
  }
  await next();
};
