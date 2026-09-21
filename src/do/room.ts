// One Durable Object per token mint, plus one "floor" room. Phones connect over WebSocket; the ingest route
// posts JSON to /broadcast and every socket in the room gets it. Hibernation keeps idle rooms free.
import { DurableObject } from "cloudflare:workers";
import type { Env } from "../env";

const MAX_SOCKETS = 5000;

export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (req.headers.get("Upgrade") === "websocket") {
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS) return new Response("room full", { status: 503 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (url.pathname === "/broadcast" && req.method === "POST") {
      const body = await req.text();
      let n = 0;
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(body);
          n++;
        } catch {
          /* closing */
        }
      }
      return Response.json({ sent: n });
    }
    if (url.pathname === "/size") return Response.json({ sockets: this.ctx.getWebSockets().length });
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    if (msg === "ping") ws.send("pong"); // phones send ping every 25s; anything else is ignored
  }
  webSocketClose(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
  webSocketError(ws: WebSocket) {
    try {
      ws.close();
    } catch {
      /* already closed */
    }
  }
}
