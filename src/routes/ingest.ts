// Indexer → Worker. Body is an IngestBatch, header x-signature is HMAC-SHA256(INGEST_SECRET, body).
// Batches older than 60s are rejected so a captured request can't be replayed later.
import { Hono } from "hono";
import type { Env } from "../env";
import { verify } from "../lib/hmac";
import { badRequest, unauthorized } from "../lib/errors";
import { IngestBatch, type WsMessage } from "../contract";
import { rooms, STOCK, userRoom } from "../services/rooms";

export const ingest = new Hono<{ Bindings: Env }>();

ingest.post("/trades", async (c) => {
  const body = await c.req.text();
  if (body.length > 1_000_000) throw badRequest("batch too large");
  if (!(await verify(c.env.INGEST_SECRET, body, c.req.header("x-signature")))) throw unauthorized();
  const r = IngestBatch.safeParse(JSON.parse(body));
  // The sender is HMAC-authenticated, so name what failed: a silent 400 makes a dropped batch unexplainable.
  if (!r.success) {
    const i = r.error.issues[0];
    console.error("bad batch", JSON.stringify(r.error.issues.slice(0, 3)));
    throw badRequest(`bad batch: ${i?.path.join(".")} ${i?.message}`);
  }
  if (Math.abs(Date.now() / 1000 - r.data.sentAt) > 60) throw unauthorized();

  const byRoom = new Map<string, WsMessage[]>();
  const push = (room: string, m: WsMessage) => byRoom.set(room, [...(byRoom.get(room) ?? []), m]);
  for (const n of r.data.news) push(STOCK(n.mint), { t: "news", ...n });
  // The indexer still reports the floor it watches; nothing subscribes to it any more, so only stonks fan out.
  for (const p of r.data.prices) if (p.kind !== "meme") push(STOCK(p.mint), { t: "price", ...p });
  for (const { userId, ...o } of r.data.orders)
    push(await userRoom(c.env.INGEST_SECRET, userId), { t: "order", ...o });
  c.executionCtx.waitUntil(rooms.publish(c.env, byRoom));
  return c.json({
    ok: true,
    prices: r.data.prices.length,
    orders: r.data.orders.length,
    rooms: byRoom.size,
  });
});
