// Row → contract. The only place DB column names meet API field names.
import { tagsFor } from "./collections";
import type { Stock } from "../contract";
import type { StockRow } from "../repos/stocks";

const num = (v: unknown): number | null => (v == null ? null : Number(v));
const int = (v: unknown): number => (v == null ? 0 : Number(v));

export type Session = "pre" | "open" | "post" | "closed";

// US equities in America/New_York: pre 04:00, regular 09:30, post 16:00, shut at 20:00. Holidays ignored for now.
export function marketSession(now = new Date()): Session {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    minute: "numeric",
    hour12: false,
  })
    .formatToParts(now)
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  if (p.weekday === "Sat" || p.weekday === "Sun") return "closed";
  const m = Number(p.hour) * 60 + Number(p.minute);
  if (m >= 570 && m < 960) return "open";
  if (m >= 240 && m < 570) return "pre";
  if (m >= 960 && m < 1200) return "post";
  return "closed";
}
export const marketOpen = (now = new Date()) => marketSession(now) === "open";

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
});
