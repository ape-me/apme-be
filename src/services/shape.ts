// Row → contract. The only place DB column names meet API field names.
import { tagsFor } from "./collections";
import type { Stock, TokenCard, TokenHeader, Trade, Candle } from "../contract";
import type { StockRow } from "../repos/stocks";
import type { TokenRow } from "../repos/tokens";
import type { TradeRow, CandleRow } from "../repos/market";

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const int = (v: unknown): number => (v == null ? 0 : Number(v));

// NYSE regular session, Mon–Fri 09:30–16:00 America/New_York. Holidays ignored for now.
export function marketOpen(now = new Date()): boolean {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  if (p.weekday === "Sat" || p.weekday === "Sun") return false;
  const m = Number(p.hour) * 60 + Number(p.minute);
  return m >= 570 && m < 960;
}

export const shapeStock = (r: StockRow, open = marketOpen()): Stock => ({
  tags: tagsFor(r),
  mint: r.mint,
  symbol: r.symbol,
  name: r.name,
  issuer: r.issuer,
  category: r.category,
  logo: r.logo,
  priceUsd: num(r.price_usd),
  change24h: num(r.change_24h),
  memes: int(r.memes ?? 0),
  marketOpen: open,
  decimals: int(r.decimals),
  multiplier: Number(r.multiplier ?? 1),
  quoteUsd: r.price_usd == null ? null : Number(r.price_usd) * Number(r.multiplier ?? 1),
  markUsd: r.mark_usd == null ? null : Math.round(r.mark_usd * 100) / 100,
  premiumPct: r.premium_pct == null ? null : Math.round(r.premium_pct * 100) / 100,
  liquidityUsd: r.liquidity_usd == null ? null : Math.round(r.liquidity_usd),
  stockVol24hUsd: r.vol_24h_usd == null ? null : Math.round(r.vol_24h_usd),
  buys24h: r.buys_24h == null ? null : int(r.buys_24h),
  sells24h: r.sells_24h == null ? null : int(r.sells_24h),
  heat: Math.round(int(r.heat)),
  launched24h: int(r.launched_24h),
  memeVol24hUsd: Math.round(int(r.meme_vol_24h)),
  wallets24h: int(r.wallets_24h),
  king: r.king_mint
    ? {
        mint: r.king_mint,
        symbol: r.king_symbol,
        image: r.king_image,
        vol24hUsd: Math.round(int(r.king_vol)),
        priceUsd: num(r.king_price),
        mcapUsd: num(r.king_mcap),
        change24h: num(r.king_change),
        phase: r.king_phase ?? "curve",
        progressPct: num(r.king_progress),
        launchpad: r.king_launchpad ?? "stonkfun",
      }
    : null,
});

export const shapeToken = (r: TokenRow): TokenCard => ({
  mint: r.mint,
  symbol: r.symbol,
  name: r.name,
  image: r.image,
  quoteMint: r.quote_mint,
  launchpad: r.launchpad,
  phase: r.phase,
  createdAt: int(r.created_at),
  priceQuote: num(r.price_quote),
  priceUsd: num(r.price_usd),
  mcapUsd: num(r.mcap_usd),
  vol24hUsd: int(r.vol_24h_usd),
  buys24h: int(r.buys_24h),
  sells24h: int(r.sells_24h),
  change24h: num(r.change_24h),
  taxBps: int(r.tax_bps),
  progressPct: num(r.progress_pct),
  lastTradeAt: num(r.last_trade_at),
  vol5mUsd: int(r.vol_5m_usd),
  buys5m: int(r.buys_5m),
  sells5m: int(r.sells_5m),
  vol1hUsd: int(r.vol_1h_usd),
  buys1h: int(r.buys_1h),
  sells1h: int(r.sells_1h),
  change1h: num(r.change_1h),
  athMcapUsd: num(r.ath_mcap_usd),
  holders: num(r.holders),
  top10Pct: num(r.top10_pct),
  devPct: num(r.dev_pct),
  snipersPct: num(r.snipers_pct),
  website: r.website,
  twitter: r.twitter,
  telegram: r.telegram,
  dexPaid: Boolean(r.dex_paid),
  dexPaidAt: num(r.dex_paid_at),
  dexBoosts: int(r.dex_boosts),
});

export const shapeHeader = (r: TokenRow, s: StockRow): TokenHeader => ({
  ...shapeToken(r),
  creator: r.creator,
  decimals: r.decimals,
  supply: r.supply,
  curvePool: r.curve_pool,
  ammPool: r.amm_pool,
  uri: r.uri,
  stock: {
    mint: s.mint,
    symbol: s.symbol,
    name: s.name,
    priceUsd: num(s.price_usd),
    change24h: num(s.change_24h),
    marketOpen: marketOpen(),
    multiplier: Number(s.multiplier ?? 1),
    quoteUsd: s.price_usd == null ? null : Number(s.price_usd) * Number(s.multiplier ?? 1),
  },
});

export const shapeTrade = (
  r: TradeRow,
  baseDec: number,
  quoteDec: number,
  stockUsd: number | null,
): Trade => {
  const priceQuote = Number(r.price_quote);
  return {
    sig: r.signature,
    ts: int(r.block_time),
    slot: int(r.slot),
    side: r.side,
    wallet: r.wallet,
    base: Number(r.base_raw) / 10 ** baseDec,
    quote: Number(r.quote_raw) / 10 ** quoteDec,
    priceQuote,
    priceUsd: stockUsd == null ? null : priceQuote * stockUsd,
  };
};

export const shapeCandle = (r: CandleRow): Candle => ({
  t: int(r.t),
  o: Number(r.o),
  h: Number(r.h),
  l: Number(r.l),
  c: Number(r.c),
  v: Number(r.v),
  n: int(r.n),
});
