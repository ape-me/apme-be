// Every shape that crosses a boundary lives here: HTTP responses, WS messages, and the indexer's ingest payload.
// zod validates what leaves the server and what the indexer sends. The iOS models are generated from these.
import { z } from "zod";

export const Mint = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/, "not a base58 pubkey");
export const Timeframe = z.enum(["1m", "5m", "15m", "1h", "4h", "1d"]);
export const Sort = z.enum([
  "volume",
  "new",
  "mcap",
  "vol5m",
  "vol1h",
  "vol24h",
  "txns1h",
  "progress",
  "change1h",
  "change24h",
]);
export const Column = z.enum(["new", "graduating", "graduated"]);
export const Launchpad = z.enum(["stonkfun", "pumpfun", "dbc"]);

export const Limit = z.coerce.number().int().min(1).max(500);
export const Ts = z.coerce.number().int().min(0);
export const Cursor = z.string().max(200).optional();

export const Stock = z.object({
  mint: Mint,
  symbol: z.string(),
  name: z.string(),
  issuer: z.string(),
  category: z.string(),
  logo: z.string().nullable(),
  priceUsd: z.number().nullable(),
  change24h: z.number().nullable(),
  marketOpen: z.boolean(),
  decimals: z.number().int(),
  // Token-2022 scaled-UI multiplier: xStocks pay dividends / do splits by raising it. 1 raw unit = `multiplier` displayed
  // units. priceUsd is per displayed unit (what wallets show). priceQuote, candles and trade `quote` are in raw units,
  // so USD = value × quoteUsd, where quoteUsd = priceUsd × multiplier.
  multiplier: z.number(),
  quoteUsd: z.number().nullable(),
  // the stock itself (Jupiter price, DexScreener depth/volume; PreStocks mark or the real underlying price)
  markUsd: z.number().nullable(),
  premiumPct: z.number().nullable(),
  liquidityUsd: z.number().nullable(),
  stockVol24hUsd: z.number().nullable(),
  buys24h: z.number().int().nullable(),
  sells24h: z.number().int().nullable(),
  tags: z.array(z.string()), // collection ids this stock belongs to, e.g. ["ai","mag7"]; filter with /stocks?collection=
});
export const Issuer = z.enum(["xstocks", "backpack", "prestocks"]);

// Stock price line for the Invest-mode chart. One point per bucket, oldest → newest; `mark` is the fair value if known.
export const HistoryRange = z.enum(["5m", "15m", "1h", "1d", "1w", "1m"]);
export const HistoryPoint = z.object({ t: z.number().int(), price: z.number(), mark: z.number().nullable() });
export const HistoryResponse = z.object({
  mint: Mint,
  range: HistoryRange,
  from: z.number().int(),
  to: z.number().int(),
  points: z.array(HistoryPoint),
  changeAbs: z.number().nullable(),
  changePct: z.number().nullable(),
});
// Home screen: hand-picked groups (ids are stable) and the three movers lists, all full Stock objects.
export const Collection = z.object({
  id: z.string(),
  title: z.string(),
  tagline: z.string(),
  stocks: z.array(Stock),
});
// US market clock, one per list response: the session belongs to the exchange, not to any one stock.
export const Market = z.object({ session: z.enum(["pre", "open", "post", "closed"]), isOpen: z.boolean() });
export const CollectionsResponse = z.object({
  collections: z.array(Collection),
  market: Market,
  asOf: z.number().int(),
});
// Portfolio. Holdings come from the chain; cost basis and P&L from our own trade tape, so they exist only for
// tokens this wallet traded on floors we index (null otherwise). Values in USD at current prices.
export const Holding = z.object({
  mint: z.string(),
  kind: z.enum(["sol", "cash", "stock"]),
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  image: z.string().nullable(),
  quoteSymbol: z.string().nullable(),
  amount: z.number(),
  raw: z.string(),
  decimals: z.number().int(),
  priceUsd: z.number().nullable(),
  valueUsd: z.number().nullable(),
  change24h: z.number().nullable(),
  costUsd: z.number().nullable(),
  avgEntryUsd: z.number().nullable(),
  feesUsd: z.number(),
  pnlUsd: z.number().nullable(),
  pnlPct: z.number().nullable(),
});
// Activity rows come from three places: our own swaps (status can be pending/failed), USDC deposits/withdrawals seen
// on chain, and meme trades from the indexer. `side` is kept for trades; `type` is the field to switch on.
export const Activity = z.object({
  sig: z.string().nullable(),
  ts: z.number().int(),
  type: z.enum(["buy", "sell", "deposit", "withdraw"]),
  status: z.enum(["pending", "confirmed", "failed"]),
  source: z.enum(["apeme", "chain"]),
  side: z.enum(["buy", "sell"]).nullable(),
  mint: z.string(),
  symbol: z.string().nullable(),
  image: z.string().nullable(),
  amount: z.number(),
  quote: z.number().nullable(),
  usd: z.number().nullable(),
  feeUsd: z.number().nullable(),
  from: z.string().nullable(),
  error: z.string().nullable(),
});
export const WalletResponse = z.object({
  address: z.string(),
  totalUsd: z.number(),
  cashUsd: z.number(),
  solUsd: z.number(),
  stocksUsd: z.number(),
  costUsd: z.number(),
  feesUsd: z.number(),
  pnlUsd: z.number(),
  realizedUsd: z.number(),
  pendingSwaps: z.number().int(),
  holdings: z.array(Holding),
  activity: z.array(Activity),
  asOf: z.number().int(),
});
export const MoversResponse = z.object({
  gainers: z.array(Stock),
  losers: z.array(Stock),
  mostTraded: z.array(Stock),
  market: Market,
  asOf: z.number().int(),
});
export type Issuer = z.infer<typeof Issuer>;
export type Stock = z.infer<typeof Stock>;

export const Trade = z.object({
  sig: z.string(),
  ts: z.number().int(),
  slot: z.number().int(),
  side: z.enum(["buy", "sell"]),
  wallet: z.string(),
  base: z.number(),
  quote: z.number(),
  priceQuote: z.number(),
  priceUsd: z.number().nullable(),
});
export type Trade = z.infer<typeof Trade>;

export const StocksResponse = z.object({ stocks: z.array(Stock), market: Market, asOf: z.number().int() });
// Indexer → Worker. One batch every 250ms. Signed with HMAC-SHA256 over the raw body.
export const IngestTrade = Trade.extend({
  mint: Mint,
  pool: z.string(),
  program: z.string(),
  quoteMint: Mint.optional(),
});
export const IngestToken = z.object({
  event: z.enum(["created", "graduated"]),
  mint: Mint,
  symbol: z.string().nullable(),
  name: z.string().nullable(),
  quoteMint: Mint,
  launchpad: z.string(),
  creator: z.string().nullable(),
  createdAt: z.number().int(),
  ts: z.number().int(),
});
// Stock price tick (Jupiter, every 5s, only when it moved). markUsd/change24h are the stock's last rollup values.
export const IngestPrice = z.object({
  mint: Mint,
  kind: z.enum(["stock", "meme"]).default("stock"),
  ts: z.number().int(),
  priceUsd: z.number(),
  markUsd: z.number().nullable(),
  change24h: z.number().nullable(),
});
export const IngestNews = z.object({
  mint: Mint,
  symbol: z.string(),
  title: z.string(),
  source: z.string().nullable(),
  url: z.string(),
  publishedAt: z.number().int(),
});
// A limit order reached its end state. The cron sends the user; the Worker derives their private room.
export const IngestOrder = z.object({
  userId: z.string().max(64),
  id: z.string().max(64),
  mint: Mint,
  symbol: z.string().nullable(),
  side: z.enum(["buy", "sell"]),
  status: z.enum(["filled", "cancelled", "expired"]),
  fillUsd: z.number().nullable(),
  signature: z.string().nullable(),
});

export const IngestBatch = z.object({
  trades: z.array(IngestTrade).max(2000).default([]),
  orders: z.array(IngestOrder).max(500).default([]),
  tokens: z.array(IngestToken).max(200).default([]),
  news: z.array(IngestNews).max(200).default([]),
  // A burst of ticks can starve the indexer's 250ms flush timer, so the cap has to clear a pile-up, not a tick.
  prices: z.array(IngestPrice).max(5000).default([]),
  sentAt: z.number().int(),
});
export type IngestBatch = z.infer<typeof IngestBatch>;

// Live stock price on ws/stock:<mint>. Drives the hero price and the chart's last point without polling.
export const WsPrice = z.object({ t: z.literal("price") }).merge(IngestPrice);
// News tagged to a stonk; impact/direction/confidence come from Jev, null until scored.
export const NewsItem = z.object({
  id: z.string(),
  mint: Mint,
  symbol: z.string(),
  name: z.string(),
  image: z.string().nullable(),
  priceUsd: z.number().nullable(),
  change24h: z.number().nullable(),
  title: z.string(),
  summary: z.string().nullable(),
  source: z.string().nullable(),
  url: z.string(),
  articleImage: z.string().nullable(),
  publishedAt: z.number().int(),
  impact: z.enum(["none", "minor", "material", "major", "critical"]).nullable(),
  direction: z.enum(["bullish", "bearish", "neutral"]).nullable(),
  confidence: z.number().nullable(),
  tier1: z.boolean(),
});
export const WsNews = z.object({
  t: z.literal("news"),
  mint: Mint,
  symbol: z.string(),
  title: z.string(),
  source: z.string().nullable(),
  url: z.string(),
  publishedAt: z.number().int(),
});
export const WsOrder = z.object({ t: z.literal("order") }).merge(IngestOrder.omit({ userId: true }));
export const WsMessage = z.discriminatedUnion("t", [WsPrice, WsNews, WsOrder]);
export type WsMessage = z.infer<typeof WsMessage>;

export const TickerToken = z.object({
  id: Mint,
  label: z.string(),
  logo: z.string().nullable(),
  change24h: z.number().nullable(),
  price: z.number().nullable(),
});
export const TickerResponse = z.object({ updatedAt: z.string(), tokens: z.array(TickerToken) });

export const ErrorBody = z.object({ error: z.string(), requestId: z.string() });
