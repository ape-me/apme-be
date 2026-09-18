// GET /ws/floor or /ws/:mint with an Upgrade header. The Durable Object holds the socket.
import { Hono } from "hono";
import type { Env } from "../env";
import { Mint } from "../contract";
import { badRequest } from "../lib/errors";
import { rooms, FLOOR } from "../services/rooms";

export const ws = new Hono<{ Bindings: Env }>();

ws.get("/:room", (c) => {
  const room = c.req.param("room");
  if (room !== FLOOR && !Mint.safeParse(room).success) throw badRequest("bad room");
  if (c.req.header("Upgrade") !== "websocket") throw badRequest("expected websocket");
  return rooms.stub(c.env, room).fetch(c.req.raw);
});
