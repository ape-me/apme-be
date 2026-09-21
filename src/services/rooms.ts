import type { Env } from "../env";
import type { WsMessage } from "../contract";

export const FLOOR = "floor";
/// One room per stock: every trade and launch on that floor. Subscribe with room=stock:<mint>.
export const STOCK = (mint: string) => `stock:${mint}`;

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
