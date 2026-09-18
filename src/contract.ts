// Every shape that crosses a boundary lives here: HTTP responses, WS messages, and the indexer's ingest payload.
// zod validates what leaves the server and what the indexer sends. The iOS models are generated from these.
import { z } from "zod";

export const Mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 pubkey");
export const Timeframe = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export const Sort = z.enum(["volume", "new", "mcap"]);
export const Limit = z.coerce.number().int().min(1).max(500);
export const Cursor = z.string().max(200).optional();

export const Stock = z.object({
  mint: Mint, symbol: z.string(), name: z.string(), issuer: z.string(), category: z.string(),
  logo: z.string().nullable(), priceUsd: z.number().nullable(), change24h: z.number().nullable(),
  memes: z.number().int(), marketOpen: z.boolean(),
});
export type Stock = z.infer<typeof Stock>;

export const TokenCard = z.object({
  mint: Mint, symbol: z.string().nullable(), name: z.string().nullable(), image: z.string().nullable(),
  quoteMint: Mint, launchpad: z.string(), phase: z.enum(["curve", "graduated"]), createdAt: z.number().int(),
  priceQuote: z.number().nullable(), priceUsd: z.number().nullable(), mcapUsd: z.number().nullable(),
  vol24hUsd: z.number(), buys24h: z.number().int(), sells24h: z.number().int(), change24h: z.number().nullable(),
  taxBps: z.number().int(), progressPct: z.number().nullable(), lastTradeAt: z.number().int().nullable(),
});
export type TokenCard = z.infer<typeof TokenCard>;

export const TokenHeader = TokenCard.extend({
  creator: z.string().nullable(), decimals: z.number().int(), supply: z.string().nullable(),
  curvePool: z.string().nullable(), ammPool: z.string().nullable(), uri: z.string().nullable(),
  stock: Stock.pick({ mint: true, symbol: true, name: true, priceUsd: true, change24h: true, marketOpen: true }),
});
export type TokenHeader = z.infer<typeof TokenHeader>;

export const Candle = z.object({ t: z.number().int(), o: z.number(), h: z.number(), l: z.number(), c: z.number(), v: z.number(), n: z.number().int() });
export type Candle = z.infer<typeof Candle>;

export const Trade = z.object({
  sig: z.string(), ts: z.number().int(), slot: z.number().int(), side: z.enum(["buy", "sell"]), wallet: z.string(),
  base: z.number(), quote: z.number(), priceQuote: z.number(), priceUsd: z.number().nullable(),
});
export type Trade = z.infer<typeof Trade>;

export const StocksResponse = z.object({ stocks: z.array(Stock), asOf: z.number().int() });
export const StockTokensResponse = z.object({ stock: Stock, tokens: z.array(TokenCard), next: z.string().nullable() });
export const CandlesResponse = z.object({ mint: Mint, tf: Timeframe, candles: z.array(Candle) });
export const TradesResponse = z.object({ mint: Mint, trades: z.array(Trade) });

// Indexer → Worker. One batch every 250ms. Signed with HMAC-SHA256 over the raw body.
export const IngestTrade = Trade.extend({ mint: Mint, pool: z.string(), program: z.string() });
export const IngestBatch = z.object({ trades: z.array(IngestTrade).max(2000), sentAt: z.number().int() });
export type IngestBatch = z.infer<typeof IngestBatch>;

// Worker → phone over WebSocket.
export const WsTrade = z.object({ t: z.literal("trade"), mint: Mint }).merge(Trade);
export const WsNewToken = z.object({ t: z.literal("token"), token: TokenCard });
export const WsStats = z.object({ t: z.literal("stats"), asOf: z.number().int(), tokens: z.array(TokenCard.pick({ mint: true, priceUsd: true, mcapUsd: true, vol24hUsd: true, change24h: true, buys24h: true, sells24h: true, lastTradeAt: true })) });
export const WsMessage = z.discriminatedUnion("t", [WsTrade, WsNewToken, WsStats]);
export type WsMessage = z.infer<typeof WsMessage>;

export const ErrorBody = z.object({ error: z.string(), requestId: z.string() });
