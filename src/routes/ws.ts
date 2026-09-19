// GET /ws/floor or /ws/:mint with an Upgrade header. The Durable Object holds the socket.
import { Hono } from "hono";
import type { Env } from "../env";
import { Mint } from "../contract";
import { badRequest } from "../lib/errors";
import { rooms, FLOOR } from "../services/rooms";
import { rateLimited } from "../lib/ratelimit";

export const ws = new Hono<{ Bindings: Env }>();

ws.get("/:room", rateLimited, (c) => {
  const room = c.req.param("room");
  const isStock = room.startsWith("stock:") && Mint.safeParse(room.slice(6)).success;
  if (room !== FLOOR && !isStock && !Mint.safeParse(room).success) throw badRequest("bad room");
  if (c.req.header("Upgrade") !== "websocket") throw badRequest("expected websocket");
  return rooms.stub(c.env, room).fetch(c.req.raw);
});
