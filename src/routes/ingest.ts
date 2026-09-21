// Indexer → Worker. Body is an IngestBatch, header x-signature is HMAC-SHA256(INGEST_SECRET, body).
// Batches older than 60s are rejected so a captured request can't be replayed later.
import { Hono } from "hono";
import type { Env } from "../env";
import { verify } from "../lib/hmac";
import { badRequest, unauthorized } from "../lib/errors";
import { IngestBatch, type WsMessage } from "../contract";
import { rooms, FLOOR, STOCK } from "../services/rooms";

export const ingest = new Hono<{ Bindings: Env }>();

ingest.post("/trades", async (c) => {
  const body = await c.req.text();
  if (body.length > 1_000_000) throw badRequest("batch too large");
  if (!(await verify(c.env.INGEST_SECRET, body, c.req.header("x-signature")))) throw unauthorized();
  const r = IngestBatch.safeParse(JSON.parse(body));
  if (!r.success) throw badRequest("bad batch");
  if (Math.abs(Date.now() / 1000 - r.data.sentAt) > 60) throw unauthorized();

  const byRoom = new Map<string, WsMessage[]>();
  const push = (room: string, m: WsMessage) => byRoom.set(room, [...(byRoom.get(room) ?? []), m]);
  for (const t of r.data.trades) {
    const { pool: _p, program: _g, quoteMint, ...rest } = t;
    const msg: WsMessage = { t: "trade", ...rest };
    push(t.mint, msg);
    push(FLOOR, msg);
    if (quoteMint) push(STOCK(quoteMint), msg); // the stock page's live tape
  }
  for (const tk of r.data.tokens) {
    const msg: WsMessage = { t: "token", ...tk };
    push(FLOOR, msg);
    push(tk.mint, msg);
    push(STOCK(tk.quoteMint), msg);
  }
  for (const p of r.data.prices) push(STOCK(p.mint), { t: "price", ...p });
  c.executionCtx.waitUntil(rooms.publish(c.env, byRoom));
  return c.json({
    ok: true,
    trades: r.data.trades.length,
    tokens: r.data.tokens.length,
    prices: r.data.prices.length,
    rooms: byRoom.size,
  });
});
