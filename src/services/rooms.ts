import type { Env } from "../env";
import type { WsMessage } from "../contract";
import { sign } from "../lib/hmac";

export const FLOOR = "floor";
/// One room per stock: every trade and launch on that floor. Subscribe with room=stock:<mint>.
export const STOCK = (mint: string) => `stock:${mint}`;

// A user's own room. The name is derived from their id with the ingest secret, so it cannot be guessed from
// anything the client knows and the socket itself needs no auth: holding the name is the proof.
export const userRoom = (secret: string, userId: string) =>
  sign(secret, `room:${userId}`).then((h) => `u${h.slice(0, 32)}`);
export const USER_ROOM = /^u[0-9a-f]{32}$/;

export const rooms = {
  stub: (env: Env, name: string) => env.ROOMS.get(env.ROOMS.idFromName(name)),

  // Fan a list of messages out to their rooms. One DO call per room, messages batched as a JSON array.
  publish: async (env: Env, byRoom: Map<string, WsMessage[]>) => {
    await Promise.all(
      [...byRoom].map(([room, msgs]) =>
        rooms.stub(env, room).fetch("https://room/broadcast", { method: "POST", body: JSON.stringify(msgs) }),
      ),
    );
  },
};
