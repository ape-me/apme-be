// Every shape that crosses a boundary lives here: HTTP responses, WS messages, and the indexer's ingest payload.
// zod validates what leaves the server and what the indexer sends. The iOS models are generated from these.
import { z } from "zod";

export const Mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 pubkey");
export const Timeframe = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export const Sort = z.enum(["volume", "new", "mcap", "vol5m", "vol1h", "vol24h", "txns1h", "progress", "change1h", "change24h"]);
export const Column = z.enum(["new", "graduating", "graduated"]);
export const Launchpad = z.enum(["stonkfun", "pumpfun", "dbc"]);

// Filters shared by every token list. All optional, all combinable.
export const TokenFilters = z.object({
  minMcap: z.coerce.number().min(0).optional(), maxMcap: z.coerce.number().min(0).optional(),
  minVol1h: z.coerce.number().min(0).optional(), minVol24h: z.coerce.number().min(0).optional(),
  minAge: z.coerce.number().min(0).optional(), maxAge: z.coerce.number().min(0).optional(),           // minutes
  minProgress: z.coerce.number().min(0).max(100).optional(), maxProgress: z.coerce.number().min(0).max(100).optional(),
  minTxns1h: z.coerce.number().int().min(0).optional(), minBuys24h: z.coerce.number().int().min(0).optional(),
  maxTax: z.coerce.number().int().min(0).optional(),                                                   // bps
  minHolders: z.coerce.number().int().min(0).optional(), maxTop10: z.coerce.number().min(0).max(100).optional(),
  maxDev: z.coerce.number().min(0).max(100).optional(), maxSnipers: z.coerce.number().min(0).max(100).optional(),
  launchpad: z.string().regex(/^[a-z,]+$/).optional(),                                                  // csv of Launchpad
  dexPaid: z.coerce.number().int().min(0).max(1).optional(),
  social: z.coerce.number().int().min(0).max(1).optional(),
  q: z.string().max(44).optional(),
});
export type TokenFilters = z.infer<typeof TokenFilters>;
export const Limit = z.coerce.number().int().min(1).max(500);
export const Cursor = z.string().max(200).optional();

export const King = z.object({ mint: Mint, symbol: z.string().nullable(), image: z.string().nullable(), vol24hUsd: z.number() });
export type King = z.infer<typeof King>;

export const Stock = z.object({
  mint: Mint, symbol: z.string(), name: z.string(), issuer: z.string(), category: z.string(),
  logo: z.string().nullable(), priceUsd: z.number().nullable(), change24h: z.number().nullable(),
  memes: z.number().int(), marketOpen: z.boolean(),
  // the stock itself (Jupiter price, DexScreener depth/volume; PreStocks mark or the real underlying price)
  markUsd: z.number().nullable(), premiumPct: z.number().nullable(), liquidityUsd: z.number().nullable(),
  stockVol24hUsd: z.number().nullable(), buys24h: z.number().int().nullable(), sells24h: z.number().int().nullable(),
  // its floor, last 24h
  heat: z.number(), launched24h: z.number().int(), memeVol24hUsd: z.number(), wallets24h: z.number().int(),
  king: King.nullable(),
  tags: z.array(z.string()),   // collection ids this stock belongs to, e.g. ["ai","mag7"]; filter with /stocks?collection=
});
export const Issuer = z.enum(["xstocks", "backpack", "prestocks"]);

// Stock price line for the Invest-mode chart. One point per bucket, oldest → newest; `mark` is the fair value if known.
export const HistoryRange = z.enum(["1h", "1d", "1w", "1m"]);
export const HistoryPoint = z.object({ t: z.number().int(), price: z.number(), mark: z.number().nullable() });
export const HistoryResponse = z.object({
  mint: Mint, range: HistoryRange, from: z.number().int(), to: z.number().int(),
  points: z.array(HistoryPoint), changeAbs: z.number().nullable(), changePct: z.number().nullable(),
});
// Home screen: hand-picked groups (ids are stable) and the three movers lists, all full Stock objects.
export const Collection = z.object({ id: z.string(), title: z.string(), tagline: z.string(), stocks: z.array(Stock) });
export const CollectionsResponse = z.object({ collections: z.array(Collection), asOf: z.number().int() });
// Portfolio. Holdings come from the chain; cost basis and P&L from our own trade tape, so they exist only for
// tokens this wallet traded on floors we index (null otherwise). Values in USD at current prices.
export const Holding = z.object({
  mint: z.string(), kind: z.enum(["sol", "stock", "meme"]), symbol: z.string().nullable(), name: z.string().nullable(), image: z.string().nullable(),
  quoteSymbol: z.string().nullable(), amount: z.number(), priceUsd: z.number().nullable(), valueUsd: z.number().nullable(), change24h: z.number().nullable(),
  costUsd: z.number().nullable(), pnlUsd: z.number().nullable(), pnlPct: z.number().nullable(),
});
export const Activity = z.object({
  sig: z.string(), ts: z.number().int(), side: z.enum(["buy", "sell"]), mint: Mint, symbol: z.string().nullable(), image: z.string().nullable(),
  stockSymbol: z.string(), amount: z.number(), quote: z.number(), usd: z.number().nullable(),
});
export const WalletResponse = z.object({
  address: z.string(), totalUsd: z.number(), solUsd: z.number(), stocksUsd: z.number(), memesUsd: z.number(),
  costUsd: z.number(), pnlUsd: z.number(), realizedUsd: z.number(),
  holdings: z.array(Holding), activity: z.array(Activity), asOf: z.number().int(),
});
export const MoversResponse = z.object({ gainers: z.array(Stock), losers: z.array(Stock), mostTraded: z.array(Stock), asOf: z.number().int() });
export type Issuer = z.infer<typeof Issuer>;
export type Stock = z.infer<typeof Stock>;

export const TokenCard = z.object({
  mint: Mint, symbol: z.string().nullable(), name: z.string().nullable(), image: z.string().nullable(),
  quoteMint: Mint, launchpad: z.string(), phase: z.enum(["curve", "graduated"]), createdAt: z.number().int(),
  priceQuote: z.number().nullable(), priceUsd: z.number().nullable(), mcapUsd: z.number().nullable(),
  vol24hUsd: z.number(), buys24h: z.number().int(), sells24h: z.number().int(), change24h: z.number().nullable(),
  taxBps: z.number().int(), progressPct: z.number().nullable(), lastTradeAt: z.number().int().nullable(),
  vol5mUsd: z.number(), buys5m: z.number().int(), sells5m: z.number().int(),
  vol1hUsd: z.number(), buys1h: z.number().int(), sells1h: z.number().int(), change1h: z.number().nullable(),
  athMcapUsd: z.number().nullable(),
  holders: z.number().int().nullable(), top10Pct: z.number().nullable(), devPct: z.number().nullable(), snipersPct: z.number().nullable(),
  website: z.string().nullable(), twitter: z.string().nullable(), telegram: z.string().nullable(),
  dexPaid: z.boolean(), dexPaidAt: z.number().int().nullable(), dexBoosts: z.number().int(),
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
export const TokensResponse = z.object({ tokens: z.array(TokenCard), next: z.string().nullable() });
export const FloorResponse = z.object({ stock: Stock.nullable(), new: z.array(TokenCard), graduating: z.array(TokenCard), graduated: z.array(TokenCard), asOf: z.number().int() });

// Indexer → Worker. One batch every 250ms. Signed with HMAC-SHA256 over the raw body.
export const IngestTrade = Trade.extend({ mint: Mint, pool: z.string(), program: z.string(), quoteMint: Mint.optional() });
export const IngestToken = z.object({
  event: z.enum(["created", "graduated"]), mint: Mint, symbol: z.string().nullable(), name: z.string().nullable(), quoteMint: Mint,
  launchpad: z.string(), creator: z.string().nullable(), createdAt: z.number().int(), ts: z.number().int(),
});
export const IngestBatch = z.object({ trades: z.array(IngestTrade).max(2000), tokens: z.array(IngestToken).max(200).default([]), sentAt: z.number().int() });
export type IngestBatch = z.infer<typeof IngestBatch>;

// Worker → phone over WebSocket.
export const WsTrade = z.object({ t: z.literal("trade"), mint: Mint }).merge(Trade);
// A token was created (curve pool initialised) or graduated (AMM pool appeared). Fetch /v1/tokens/:mint for the full card.
export const WsNewToken = z.object({ t: z.literal("token") }).merge(IngestToken);
export const WsStats = z.object({ t: z.literal("stats"), asOf: z.number().int(), tokens: z.array(TokenCard.pick({ mint: true, priceUsd: true, mcapUsd: true, vol24hUsd: true, change24h: true, buys24h: true, sells24h: true, lastTradeAt: true })) });
export const WsMessage = z.discriminatedUnion("t", [WsTrade, WsNewToken, WsStats]);
export type WsMessage = z.infer<typeof WsMessage>;

export const TickerToken = z.object({
  id: Mint, kind: z.enum(["meme", "stonk"]), label: z.string(), logo: z.string().nullable(),
  change24h: z.number().nullable(), price: z.number().nullable(),
});
export const TickerResponse = z.object({ updatedAt: z.string(), tokens: z.array(TickerToken) });

export const ErrorBody = z.object({ error: z.string(), requestId: z.string() });
